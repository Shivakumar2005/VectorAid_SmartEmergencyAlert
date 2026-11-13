import threading
import time


class SharedState:
    """One writer (TX loop), many readers (dashboard). Never blocks."""

    def __init__(self):
        self._lock = threading.Lock()

        self.telemetry = {
            "lat": None, "lon": None, "alt": None,
            "speed": 0.0, "heading": None, "hdg_src": "none",
            "route_brg": None, "off_route": None,
            "sats": 0, "fix": 0,
            "seq": 0, "tx_ok": False,
            "sent": 0, "failed": 0,
            "ts": 0.0,
            "yaw_rate": 0.0, "accel_fwd": 0.0, "accel_lat": 0.0,
            "roll": 0.0, "pitch": 0.0, "vibration": 0.0,
            "route_idx": None,
            "corridor": [],
            "chunks_sent": 0,
        }

        self.route_points = []
        self.route_summary = None
        self.destination = None
        self.route_confirmed = False
        self.tx_enabled = False
        self.status_msg = "Waiting for GPS fix"

    def publish(self, **kw):
        with self._lock:
            self.telemetry.update(kw)
            self.telemetry["ts"] = time.time()

    def snapshot(self):
        with self._lock:
            d = dict(self.telemetry)
            d["route_confirmed"] = self.route_confirmed
            d["tx_enabled"] = self.tx_enabled
            d["status"] = self.status_msg
            d["dest"] = self.destination
            if self.route_summary:
                d["route_km"] = round(self.route_summary["distance"] / 1000, 2)
                d["route_min"] = round(self.route_summary["duration"] / 60)
            else:
                d["route_km"] = None
                d["route_min"] = None
            return d

    def set_route(self, points, summary, destination):
        with self._lock:
            self.route_points = points
            self.route_summary = summary
            self.destination = destination
            self.route_confirmed = True
            self.tx_enabled = True          # auto-ON once route confirmed
            self.status_msg = "Route confirmed"

    def clear_route(self):
        with self._lock:
            self.route_points = []
            self.route_summary = None
            self.destination = None
            self.route_confirmed = False
            self.tx_enabled = False
            self.status_msg = "No route set"

    def set_tx(self, enabled):
        """Transmit can only be enabled once a route is confirmed."""
        with self._lock:
            if not self.route_confirmed:
                self.tx_enabled = False
                return False
            self.tx_enabled = bool(enabled)
            return self.tx_enabled

    def get_route(self):
        with self._lock:
            return list(self.route_points)

    def set_status(self, msg):
        with self._lock:
            self.status_msg = msg