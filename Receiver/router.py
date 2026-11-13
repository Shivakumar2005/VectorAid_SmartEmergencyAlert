"""
The receiver's own destination route, via OpenRouteService.

This is the car's own navigation route and is completely separate from the
ambulance corridor arriving over the radio. Routing is a planning-time
operation: fetched once when you set a destination, cached to disk, then
consumed locally as you drive. No network access is needed while moving.
"""

import json
import os
import threading
from collections import OrderedDict

import requests

import config
import geo


def explain_ors_error(response):
    """Turn an ORS error response into a plain, actionable sentence."""
    code, message = response.status_code, ""
    try:
        err = response.json().get("error")
        if isinstance(err, dict):
            message = err.get("message", "")
            code = err.get("code", code)
        elif err:
            message = str(err)
    except ValueError:
        message = response.text[:160]

    status = response.status_code
    if status in (401, 403) and "quota" not in message.lower():
        return "ORS rejected the API key - check ORS_API_KEY in .env (%s)" % (message or status)
    if status == 429 or "quota" in message.lower():
        return "ORS request limit reached - wait a minute and try again"
    if code == 2010:
        return ("no road within 350 m of your position or the destination - "
                "check the GPS fix, or pick a point on a road")
    if code == 2004:
        return "route is too long for the free ORS plan"
    return "ORS error %s: %s" % (status, message or "no details")


# ------------------------------------------------------ place search ----
_search_cache = OrderedDict()
_search_lock = threading.Lock()


def search_places(text, near=None):
    """
    Type-ahead place search through the ORS geocoder (Pelias autocomplete).
    near=(lat, lon) ranks nearby places first. Returns a list of
    {"name", "detail", "lat", "lon"}. Raises on network or key errors.
    """
    text = (text or "").strip()
    if len(text) < 3:
        return []
    if not config.ORS_API_KEY:
        raise RuntimeError("ORS_API_KEY not set - put it in .env on this Pi")

    # Round the bias point so small GPS jitter still hits the cache.
    near_key = (round(near[0], 2), round(near[1], 2)) if near else None
    key = (text.lower(), near_key)
    with _search_lock:
        if key in _search_cache:
            _search_cache.move_to_end(key)
            return _search_cache[key]

    params = {"text": text, "size": config.SEARCH_RESULTS,
              "boundary.country": config.SEARCH_COUNTRY}
    if near:
        params["focus.point.lat"] = near[0]
        params["focus.point.lon"] = near[1]

    response = requests.get(config.ORS_AUTOCOMPLETE_URL, params=params,
                            headers={"Authorization": config.ORS_API_KEY},
                            timeout=8)
    if response.status_code in (401, 403):
        # Some ORS gateways only accept the key as a query parameter.
        params["api_key"] = config.ORS_API_KEY
        response = requests.get(config.ORS_AUTOCOMPLETE_URL, params=params,
                                timeout=8)
    response.raise_for_status()

    results = []
    for feature in response.json().get("features", []):
        props = feature.get("properties", {})
        coords = (feature.get("geometry") or {}).get("coordinates")
        if not coords or len(coords) < 2:
            continue
        name = props.get("name") or props.get("label") or "Unnamed place"
        label = props.get("label") or name
        detail = label[len(name):].lstrip(", ") if label.startswith(name) else label
        results.append({"name": name, "detail": detail,
                        "lat": float(coords[1]), "lon": float(coords[0])})

    with _search_lock:
        _search_cache[key] = results
        while len(_search_cache) > 200:
            _search_cache.popitem(last=False)
    return results


class OwnRoute:
    def __init__(self):
        self.lock = threading.Lock()
        self.points = []
        self.summary = None
        self.destination = None
        self.cumulative = []
        self.progress_m = 0.0
        self._load()

    # ------------------------------------------------------------ storage --
    def _load(self):
        if not os.path.exists(config.ROUTE_CACHE):
            return
        try:
            with open(config.ROUTE_CACHE) as fh:
                data = json.load(fh)
            self.points = [tuple(p) for p in data["points"]]
            self.summary = data.get("summary")
            self.destination = tuple(data["destination"])
            self.cumulative = geo.cumulative(self.points)
            print("[route] loaded cached route: %d points" % len(self.points))
        except Exception as exc:
            print("[route] could not load cache: %s" % exc)

    def _save(self):
        try:
            with open(config.ROUTE_CACHE, "w") as fh:
                json.dump({"points": self.points,
                           "summary": self.summary,
                           "destination": self.destination}, fh)
        except OSError as exc:
            print("[route] could not save cache: %s" % exc)

    # -------------------------------------------------------------- fetch --
    def set_destination(self, start, destination):
        """start and destination are (lat, lon). Raises on failure."""
        if not config.ORS_API_KEY:
            raise RuntimeError(
                "ORS_API_KEY not set - put it in .env on this Pi")

        try:
            response = requests.post(
                config.ORS_URL.format(profile=config.ORS_PROFILE),
                headers={"Authorization": config.ORS_API_KEY,
                         "Content-Type": "application/json"},
                json={"coordinates": [[start[1], start[0]],
                                      [destination[1], destination[0]]]},
                timeout=20,
            )
        except requests.exceptions.RequestException as exc:
            raise RuntimeError(
                "can't reach openrouteservice - this Pi has no working internet "
                "(%s)" % type(exc).__name__) from None
        if response.status_code != 200:
            raise RuntimeError(explain_ors_error(response))
        feature = response.json()["features"][0]
        points = [(c[1], c[0]) for c in feature["geometry"]["coordinates"]]

        with self.lock:
            self.points = points
            self.summary = feature["properties"]["summary"]
            self.destination = tuple(destination)
            self.cumulative = geo.cumulative(points)
            self.progress_m = 0.0
            self._save()

        print("[route] %d points, %.1f km, %.0f min"
              % (len(points), self.summary["distance"] / 1000.0,
                 self.summary["duration"] / 60.0))
        return self.snapshot()

    def clear(self):
        with self.lock:
            self.points = []
            self.summary = None
            self.destination = None
            self.cumulative = []
            self.progress_m = 0.0
        try:
            os.remove(config.ROUTE_CACHE)
        except OSError:
            pass

    # ----------------------------------------------------------- progress --
    def update_progress(self, lat, lon):
        """
        Windowed forward map-matching, so the route consumes itself as you
        drive and a nearby later segment cannot steal the match.
        """
        with self.lock:
            if len(self.points) < 2:
                return
            total = self.cumulative[-1]
            lo_m = max(0.0, self.progress_m - 40.0)
            hi_m = min(total, self.progress_m + 250.0)

            best_d, best_m = float("inf"), self.progress_m
            for i, dist_along in enumerate(self.cumulative):
                if dist_along < lo_m or dist_along > hi_m:
                    continue
                d = geo.haversine_m(lat, lon,
                                    self.points[i][0], self.points[i][1])
                if d < best_d:
                    best_d, best_m = d, dist_along
            self.progress_m = best_m

    def snapshot(self):
        with self.lock:
            if not self.points:
                return {"points": [], "destination": None,
                        "remaining_km": None, "remaining_min": None,
                        "progress_m": 0.0}

            remaining = []
            for i, dist_along in enumerate(self.cumulative):
                if dist_along >= self.progress_m:
                    remaining.append(self.points[i])

            total = self.cumulative[-1] or 1.0
            frac = max(0.0, (total - self.progress_m) / total)
            return {
                "points": remaining or self.points[-1:],
                "destination": self.destination,
                "remaining_km": (self.summary["distance"] / 1000.0 * frac
                                 if self.summary else None),
                "remaining_min": (self.summary["duration"] / 60.0 * frac
                                  if self.summary else None),
                "progress_m": self.progress_m,
            }