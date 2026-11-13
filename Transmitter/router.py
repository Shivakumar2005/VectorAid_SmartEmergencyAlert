"""Routing for the transmitter.

fetch_route / save_route / load_route - ORS route, cached to route.json
geocode                               - place search via Nominatim
Route                                 - map matching, lookahead bearing and
                                        the transmitted corridor window
"""

import json
import math
import os

import requests

from geo import haversine_m, bearing_deg

ORS_URL = "https://api.openrouteservice.org/v2/directions/{profile}/geojson"
NOMINATIM = "https://nominatim.openstreetmap.org/search"


def fetch_route(api_key, start, end, profile="driving-car"):
    """start/end are (lat, lon). Returns list of (lat, lon) and a summary."""
    r = requests.post(
        ORS_URL.format(profile=profile),
        headers={"Authorization": api_key, "Content-Type": "application/json"},
        json={"coordinates": [[start[1], start[0]], [end[1], end[0]]]},
        timeout=20,
    )
    r.raise_for_status()
    feat = r.json()["features"][0]
    pts = [(c[1], c[0]) for c in feat["geometry"]["coordinates"]]
    return pts, feat["properties"]["summary"]


def geocode(query, near=None, limit=6):
    """Search a place name via Nominatim. near=(lat, lon) biases results."""
    params = {"q": query, "format": "json", "limit": limit, "addressdetails": 1}
    if near and near[0] is not None:
        lat, lon = near
        d = 0.5
        params["viewbox"] = f"{lon-d},{lat+d},{lon+d},{lat-d}"
        params["bounded"] = 0

    r = requests.get(
        NOMINATIM,
        params=params,
        headers={"User-Agent": "V2V-Ambulance-Project/1.0"},
        timeout=15,
    )
    r.raise_for_status()
    return [
        {
            "name": i.get("display_name", ""),
            "lat": float(i["lat"]),
            "lon": float(i["lon"]),
            "type": i.get("type", ""),
        }
        for i in r.json()
    ]


def save_route(path, pts, summary):
    with open(path, "w") as f:
        json.dump({"points": pts, "summary": summary}, f)


def load_route(path):
    if not os.path.exists(path):
        return None, None
    with open(path) as f:
        d = json.load(f)
    return [tuple(p) for p in d["points"]], d["summary"]


class Route:
    """ORS route with segment-based, forward-only map matching.

    The vehicle is projected onto the nearest route SEGMENT (not the nearest
    vertex), so the corridor and the lookahead both start at a point that is
    ON the road and then follow every route vertex ahead. ORS only puts
    vertices at bends, so matching to vertices alone produced chords that
    cut across buildings.
    """

    # how far the match may slide per update, along the route
    BACK_WINDOW_M = 30.0     # small allowance for GPS jitter
    FWD_WINDOW_M = 300.0     # forward search limit - stops leg-hopping

    def __init__(self, points):
        self.points = list(points)
        self.idx = 0                 # start vertex of the matched segment
        self.progress_m = 0.0        # arc length from route start to the match
        self.proj = self.points[0] if self.points else None
        self.last_bearing = None
        self.cum = [0.0]
        for i in range(1, len(self.points)):
            a, b = self.points[i - 1], self.points[i]
            self.cum.append(self.cum[-1] + haversine_m(a[0], a[1], b[0], b[1]))

    # ------------------------------------------------------------ matching --
    @staticmethod
    def _xy(lat, lon, ref_lat, ref_lon):
        k = 111319.49
        return ((lon - ref_lon) * k * math.cos(math.radians(ref_lat)),
                (lat - ref_lat) * k)

    def _locate(self, lat, lon):
        """Project the vehicle onto the best segment inside the search window.
        Updates idx / progress_m / proj. Returns the off-route distance (m)."""
        n = len(self.points)
        if n == 1:
            self.idx, self.proj = 0, self.points[0]
            return haversine_m(lat, lon, *self.points[0])

        lo_m = self.progress_m - self.BACK_WINDOW_M
        hi_m = self.progress_m + self.FWD_WINDOW_M

        best = None
        for i in range(n - 1):
            if self.cum[i + 1] < lo_m:
                continue
            if self.cum[i] > hi_m:
                break
            a, b = self.points[i], self.points[i + 1]
            ax, ay = 0.0, 0.0
            bx, by = self._xy(b[0], b[1], a[0], a[1])
            px, py = self._xy(lat, lon, a[0], a[1])
            seg_sq = bx * bx + by * by
            t = 0.0 if seg_sq < 1e-9 else max(0.0, min(1.0, (px * bx + py * by) / seg_sq))
            cx, cy = bx * t, by * t
            off = math.hypot(px - cx, py - cy)
            if best is None or off < best[0]:
                best = (off, i, t)

        if best is None:                      # window empty - keep last match
            return haversine_m(lat, lon, *self.proj)

        off, i, t = best
        a, b = self.points[i], self.points[i + 1]
        self.idx = i
        self.proj = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        self.progress_m = self.cum[i] + (self.cum[i + 1] - self.cum[i]) * t
        return off

    def _walk(self, dist_m):
        """From the matched point ON the route, follow every vertex ahead for
        dist_m. The last point is interpolated so the span is exactly dist_m."""
        pts = [self.proj]
        prev = self.proj
        acc = 0.0
        j = self.idx + 1
        while j < len(self.points) and acc < dist_m:
            p = self.points[j]
            d = haversine_m(prev[0], prev[1], p[0], p[1])
            if d > 0 and acc + d >= dist_m:
                t = (dist_m - acc) / d
                pts.append((prev[0] + (p[0] - prev[0]) * t,
                            prev[1] + (p[1] - prev[1]) * t))
                break
            if d > 0:
                pts.append(p)
            acc += d
            prev = p
            j += 1
        return pts

    # -------------------------------------------------------------- public --
    def update(self, lat, lon, lookahead_m=50.0):
        """Returns (bearing_to_point_lookahead_m_ahead, off_route_m, idx)."""
        if not self.points:
            return None, None, None

        off = self._locate(lat, lon)
        ahead = self._walk(lookahead_m)
        tlat, tlon = ahead[-1]

        # At the destination the target collapses onto us - hold last bearing.
        if haversine_m(self.proj[0], self.proj[1], tlat, tlon) < 2.0:
            return self.last_bearing, off, self.idx

        # Bearing along the ROAD, from the matched point - not from the raw
        # GPS fix, which may sit several metres off the road.
        self.last_bearing = bearing_deg(self.proj[0], self.proj[1], tlat, tlon)
        return self.last_bearing, off, self.idx

    def corridor(self, lat, lon, length_m=100.0):
        """The transmitted window: length_m of road ahead of the vehicle."""
        if not self.points:
            return []
        self._locate(lat, lon)
        return self._walk(length_m)