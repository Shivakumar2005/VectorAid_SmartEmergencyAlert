"""
Geometry for the receiver.

Two ways to decide whether the car is in the ambulance's path:

  evaluate_corridor()  point-to-segment projection over the received
                       waypoint polyline. This is the ESP32 algorithm and
                       the accurate one - it follows the road through bends.

  evaluate_ray()       cross-track offset from a single straight bearing.
                       Used only until the first corridor arrives.

Both report the same fields, so the alert logic above them is identical.
"""

import math

EARTH_RADIUS_M = 6371008.8


def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angle_diff(a, b):
    """Smallest signed difference a - b, in (-180, 180]."""
    return (a - b + 180.0) % 360.0 - 180.0


def offset_point(lat, lon, bearing, distance_m):
    d = distance_m / EARTH_RADIUS_M
    b = math.radians(bearing)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d)
                   + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1),
                         math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def to_local_xy(lat, lon, ref_lat, ref_lon):
    """Equirectangular metres relative to a reference point."""
    x = (math.radians(lon - ref_lon)
         * math.cos(math.radians(ref_lat)) * EARTH_RADIUS_M)
    y = math.radians(lat - ref_lat) * EARTH_RADIUS_M
    return x, y


def project_on_segment(px, py, ax, ay, bx, by):
    """
    Project P onto segment AB.

    t is returned UNCLAMPED: t < 0 means P sits behind A, t > 1 beyond B.
    That sign is what distinguishes "the ambulance is coming" from "it has
    already gone past you". Also returns the segment length so the caller can
    convert t into metres.
    """
    abx, aby = bx - ax, by - ay
    seg_sq = abx * abx + aby * aby
    if seg_sq < 1e-9:
        return 0.0, math.hypot(px - ax, py - ay), 0.0
    t = ((px - ax) * abx + (py - ay) * aby) / seg_sq
    tc = max(0.0, min(1.0, t))
    cx, cy = ax + tc * abx, ay + tc * aby
    return t, math.hypot(px - cx, py - cy), math.sqrt(seg_sq)


def _direction(car_heading, reference_bearing, same_max, opposite_min):
    if car_heading is None:
        return "UNKNOWN"
    delta = abs(angle_diff(car_heading, reference_bearing))
    if delta <= same_max:
        return "SAME"
    if delta >= opposite_min:
        return "OPPOSITE"
    return "CROSSING"


def evaluate_corridor(car_lat, car_lon, car_heading, corridor,
                      half_width_m, behind_hysteresis_m,
                      same_max, opposite_min):
    """
    Point-to-segment matching against the corridor polyline.

    in_path = perpendicular offset <= half_width AND not behind the corridor
    start by more than the hysteresis margin.
    """
    result = {
        "offset_m": None, "along_m": None, "ahead": False, "in_path": False,
        "direction": "UNKNOWN", "reference_bearing": None,
        "behind": False, "mode": "corridor",
    }
    if not corridor or len(corridor) < 2:
        return result

    ref_lat, ref_lon = corridor[0]
    px, py = to_local_xy(car_lat, car_lon, ref_lat, ref_lon)

    best = {"offset": float("inf"), "index": 0, "t": 0.0, "seg_len": 0.0,
            "lateral": float("inf")}
    for i in range(len(corridor) - 1):
        ax, ay = to_local_xy(corridor[i][0], corridor[i][1], ref_lat, ref_lon)
        bx, by = to_local_xy(corridor[i + 1][0], corridor[i + 1][1],
                             ref_lat, ref_lon)
        t, offset, seg_len = project_on_segment(px, py, ax, ay, bx, by)
        if offset < best["offset"]:
            # Sideways distance from the segment's LINE (not its end point).
            # Behind the ambulance this says whether you are still on its
            # road, which the clamped offset cannot.
            lateral = (abs((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / seg_len
                       if seg_len > 1e-6 else offset)
            best = {"offset": offset, "index": i, "t": t, "seg_len": seg_len,
                    "lateral": lateral}

    # Behind the corridor origin, with the ESP32's 5 m hysteresis margin.
    behind = (best["index"] == 0 and best["t"] < 0.0
              and (-best["t"] * best["seg_len"]) > behind_hysteresis_m)

    seg_bearing = bearing_deg(corridor[best["index"]][0],
                              corridor[best["index"]][1],
                              corridor[best["index"] + 1][0],
                              corridor[best["index"] + 1][1])

    # Distance travelled along the corridor to reach the projection point.
    along = 0.0
    for i in range(best["index"]):
        along += haversine_m(corridor[i][0], corridor[i][1],
                             corridor[i + 1][0], corridor[i + 1][1])
    along += max(0.0, min(1.0, best["t"])) * best["seg_len"]

    result.update({
        "offset_m": best["offset"],
        "lateral_m": best["lateral"],
        "along_m": along,
        "ahead": not behind,
        "behind": behind,
        "in_path": (best["offset"] <= half_width_m) and not behind,
        "reference_bearing": seg_bearing,
        # Direction is judged against the ROAD, not the ambulance's
        # instantaneous heading - robust when it is mid-turn.
        "direction": _direction(car_heading, seg_bearing,
                                same_max, opposite_min),
    })
    return result


def evaluate_ray(car_lat, car_lon, car_heading, amb_lat, amb_lon,
                 route_bearing, half_width_m, same_max, opposite_min):
    """Straight-ray fallback, used until the first corridor arrives."""
    distance = haversine_m(car_lat, car_lon, amb_lat, amb_lon)
    to_car = bearing_deg(amb_lat, amb_lon, car_lat, car_lon)
    rad = math.radians(angle_diff(to_car, route_bearing))
    along = distance * math.cos(rad)
    offset = abs(distance * math.sin(rad))
    ahead = along > 0.0
    return {
        "offset_m": offset,
        "lateral_m": offset,
        "along_m": along,
        "ahead": ahead,
        "behind": not ahead,
        "in_path": ahead and offset <= half_width_m,
        "reference_bearing": route_bearing,
        "direction": _direction(car_heading, route_bearing,
                                same_max, opposite_min),
        "mode": "ray",
    }


def relative_clock(car_heading, bearing_to_target):
    if car_heading is None:
        return None, "unknown"
    rel = (bearing_to_target - car_heading + 360.0) % 360.0
    names = ["ahead", "ahead-right", "right", "behind-right",
             "behind", "behind-left", "left", "ahead-left"]
    return rel, names[int(((rel + 22.5) % 360) // 45)]


def cumulative(points):
    """Running arc length along a polyline, for route consumption."""
    out = [0.0]
    for i in range(1, len(points)):
        out.append(out[-1] + haversine_m(points[i - 1][0], points[i - 1][1],
                                         points[i][0], points[i][1]))
    return out