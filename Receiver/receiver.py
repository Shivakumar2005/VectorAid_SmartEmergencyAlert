#!/usr/bin/env python3
"""
Vector Aid - receiver node.

    python3 receiver.py

Dashboard on http://<pi-ip>:9000
"""

import socket
import sys
import threading
import time

import config
import geo
import router
import server
from radio_link import RadioLink
from router import OwnRoute
from sensors import GPSReader, HeadingEstimator

gps = GPSReader()
heading = HeadingEstimator(gps)
radio = RadioLink()
own_route = OwnRoute()

EMPTY_PATH = {
    "offset_m": None, "lateral_m": None, "along_m": None, "ahead": False,
    "in_path": False, "direction": "UNKNOWN", "reference_bearing": None,
    "behind": False, "mode": "none",
}


class PassTracker:
    """
    Decides when the ambulance has gone past this car, and remembers it.

    "Passed" means you are now behind the ambulance on its road: either you
    were in its path and it has gone by, or you are simply behind it on the
    same road. It is latched so the map doesn't flicker at the crossing, and
    released only by a genuine new approach.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.passed = False
        self.was_in_path = False
        self.last_seen = 0.0

    def _forget(self):
        self.passed = False
        self.was_in_path = False

    def update(self, usable, path, distance):
        now = time.time()
        with self.lock:
            if not usable:
                if now - self.last_seen > config.PASSED_RESET_S:
                    self._forget()
                return self.passed
            self.last_seen = now

            along = path["along_m"]
            if path["mode"] == "corridor":
                behind = path["behind"]
            else:
                behind = along is not None and along < -config.BEHIND_HYSTERESIS_M
            lateral = path.get("lateral_m")
            on_its_road = lateral is not None and lateral <= config.PATH_HALF_WIDTH_M

            if self.passed:
                if path["in_path"] and along is not None and along >= config.REAPPEAR_AHEAD_M:
                    self.passed = False             # it is approaching again
                    self.was_in_path = True
            elif path["in_path"]:
                self.was_in_path = True
            elif behind and (self.was_in_path or on_its_road):
                self.passed = True
                self.was_in_path = False
            return self.passed


passes = PassTracker()


def classify(path, emergency, distance):
    """
    Unchanged from the existing build:
      CRITICAL  in path and closer than 50 m
      WARNING   in path at any greater distance
      NONE      off path, passed, out of range, or no emergency active
    """
    if not emergency:
        return "NONE", "Ambulance is not in emergency mode"
    if distance is not None and distance > config.MAX_ALERT_RANGE_M:
        return "NONE", "Ambulance is out of range"
    if not path["ahead"]:
        return "NONE", "Ambulance has already passed you"
    if not path["in_path"]:
        return "NONE", "You are clear of the ambulance route"
    if distance is not None and distance < config.CRITICAL_DISTANCE_M:
        return "CRITICAL", "Ambulance is on you - pull over now"
    return "WARNING", "Ambulance approaching on your road"


def build_state():
    fix = gps.snapshot()
    head = heading.snapshot()
    link = radio.snapshot()

    # Only a LIVE ambulance is shown. When its packets stop (it has driven
    # out of radio range, or stopped transmitting) the last position is
    # stale, so it is dropped instead of being drawn frozen on the map.
    tx = link["telemetry"] if link["up"] else None
    corridor = link["corridor"]
    car_lat, car_lon = fix["lat"], fix["lon"]
    car_heading = head["heading"]

    # Indoor bench override - a real GPS fix always wins.
    bench = False
    if (car_lat is None or not fix["fix"]) and config.BENCH_CAR_POS:
        car_lat, car_lon = config.BENCH_CAR_POS
        bench = True

    path = dict(EMPTY_PATH)
    distance = None
    relative = "unknown"
    ray_end = None

    have_car = car_lat is not None and car_lon is not None
    usable = link["up"] and tx is not None and have_car

    if have_car:
        own_route.update_progress(car_lat, car_lon)

    if usable:
        distance = geo.haversine_m(car_lat, car_lon, tx["lat"], tx["lon"])

        if config.USE_CORRIDOR_MATCHING and len(corridor) >= 2:
            path = geo.evaluate_corridor(
                car_lat, car_lon, car_heading, corridor,
                config.PATH_HALF_WIDTH_M, config.BEHIND_HYSTERESIS_M,
                config.SAME_DIRECTION_MAX_DEG,
                config.OPPOSITE_DIRECTION_MIN_DEG)
        else:
            path = geo.evaluate_ray(
                car_lat, car_lon, car_heading, tx["lat"], tx["lon"],
                tx["route_bearing"], config.PATH_HALF_WIDTH_M,
                config.SAME_DIRECTION_MAX_DEG,
                config.OPPOSITE_DIRECTION_MIN_DEG)
            ray_end = geo.offset_point(tx["lat"], tx["lon"],
                                       tx["route_bearing"], 150.0)

        _rel, relative = geo.relative_clock(
            car_heading,
            geo.bearing_deg(car_lat, car_lon, tx["lat"], tx["lon"]))

    severity, message = classify(
        path, tx["emergency"] if tx else False, distance)
    if not usable:
        severity, message = "NONE", (
            "Waiting for GPS fix" if link["up"] else "No ambulance in range")

    # Once it has gone past you, the ambulance and its corridor are withdrawn
    # from the dashboard entirely - nothing left to react to.
    passed = passes.update(usable, path, distance)
    if passed:
        severity, message = "NONE", "Ambulance has passed you - road clear"
        tx, corridor, ray_end, distance, relative = None, [], None, None, "unknown"
        link = dict(link, corridor_version=None)
        path = dict(EMPTY_PATH, mode=path["mode"])

    route = own_route.snapshot()

    return {
        "timestamp": time.time(),
        "alert": {
            "severity": severity,
            "message": message,
            "direction": path["direction"],
            "relative": relative,
        },
        "ambulance": ({
            "node_id": tx["node_id"],
            "lat": tx["lat"],
            "lon": tx["lon"],
            "heading": tx["heading"],
            "route_bearing": tx["route_bearing"],
            "speed_kmh": tx["speed_kmh"],
            "altitude_m": tx["altitude_m"],
            "sats": tx["sats"],
            "emergency": tx["emergency"],
            "off_route": tx["off_route"],
        } if tx else None),
        "car": {
            "lat": car_lat,
            "lon": car_lon,
            "heading": car_heading,
            "heading_source": head["source"],
            "speed_kmh": fix["speed_ms"] * 3.6,
            "satellites": fix["satellites"],
            "fix": fix["fix"],
            "bench": bench,
        },
        "corridor": {
            "points": corridor,
            "version": link["corridor_version"],
            "age_s": link["corridor_age_s"],
        },
        "path": {
            "in_path": path["in_path"],
            "ahead": path["ahead"],
            "offset_m": path["offset_m"],
            "along_m": path["along_m"],
            "mode": path["mode"],
            "ray_end": ray_end,
        },
        "route": route,
        "passed": passed,
        "distance_m": distance,
        "link": {
            "up": link["up"],
            "age_s": link["age_s"],
            "received": link["received"],
            "corridor_chunks": link["corridor_chunks"],
            "missed": link["missed"],
            "unknown": link["unknown"],
            "loss_pct": link["loss_pct"],
            "strong_signal": link["strong_signal"],
            "imu_ok": head["imu_ok"],
            "error": link["error"],
        },
    }


def car_position():
    """Real GPS fix if there is one, else the bench position, else None."""
    fix = gps.snapshot()
    if fix["lat"] is not None and fix["fix"]:
        return fix["lat"], fix["lon"]
    if config.BENCH_CAR_POS:
        return tuple(config.BENCH_CAR_POS)
    if fix["lat"] is not None:
        return fix["lat"], fix["lon"]
    return None


def set_destination(lat, lon):
    start = car_position()
    if start is None:
        raise RuntimeError("no GPS fix yet - cannot route from here")
    own_route.set_destination(start, (lat, lon))
    return own_route.snapshot()


def clear_destination():
    own_route.clear()
    return own_route.snapshot()


def search(query):
    return router.search_places(query, car_position())


def local_ip():
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        addr = probe.getsockname()[0]
        probe.close()
        return addr
    except Exception:
        return "127.0.0.1"


def main():
    print("Vector Aid receiver starting...")
    if not config.ORS_API_KEY:
        print("[route] no ORS_API_KEY in .env - destination routing disabled")
    if config.BENCH_CAR_POS:
        print("[bench] BENCH_CAR_POS is set - car is faked at %.6f, %.6f "
              "until a real GPS fix arrives. Set it to None for the field."
              % config.BENCH_CAR_POS)

    gps.start()
    heading.start()
    radio.start()

    server.STATE_PROVIDER = build_state
    server.SET_DESTINATION = set_destination
    server.CLEAR_DESTINATION = clear_destination
    server.SEARCH = search
    httpd = server.serve_forever()
    print("\n  Dashboard:  http://%s:%d\n" % (local_ip(), config.HTTP_PORT))

    last = 0.0
    try:
        while True:
            time.sleep(0.5)
            if time.time() - last < 2.0:
                continue
            last = time.time()
            s = build_state()
            dist, off = s["distance_m"], s["path"]["offset_m"]
            print("[%-8s] link=%-4s rx=%d cor=%d/%s loss=%.0f%% gps=%-6s "
                  "dist=%-7s off=%-7s mode=%-8s %s"
                  % (s["alert"]["severity"],
                     "up" if s["link"]["up"] else "down",
                     s["link"]["received"], s["link"]["corridor_chunks"],
                     len(s["corridor"]["points"]),
                     s["link"]["loss_pct"],
                     "fix" if s["car"]["fix"] else "no-fix",
                     "%.0fm" % dist if dist is not None else "--",
                     "%.0fm" % off if off is not None else "--",
                     s["path"]["mode"],
                     s["alert"]["message"]))
    except KeyboardInterrupt:
        print("\nStopping...")
        radio.stop()
        heading.stop()
        gps.stop()
        httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())