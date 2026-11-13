import os
import threading
import serial
import pynmea2


class GPS:
    def __init__(self, port, baud):
        if not os.path.exists(port):
            raise SystemExit(f"{port} not found - is the UART enabled?")

        self.ser = serial.Serial(port, baud, timeout=1)
        self.lock = threading.Lock()
        self.lat = None
        self.lon = None
        self.alt = None
        self.speed_kmh = 0.0
        self.cog = None
        self.sats = 0
        self.fix = 0
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                line = self.ser.readline().decode("ascii", errors="replace").strip()
                if not line.startswith("$"):
                    continue
                msg = pynmea2.parse(line)
            except Exception:
                continue

            with self.lock:
                if msg.sentence_type == "GGA":
                    try:
                        self.fix = int(msg.gps_qual)
                        self.sats = int(msg.num_sats)
                        if self.fix > 0:
                            self.lat = msg.latitude
                            self.lon = msg.longitude
                            if msg.altitude is not None:
                                self.alt = float(msg.altitude)
                    except (ValueError, TypeError):
                        pass

                elif msg.sentence_type == "RMC" and msg.status == "A":
                    if msg.spd_over_grnd is not None:
                        self.speed_kmh = float(msg.spd_over_grnd) * 1.852
                    self.cog = (float(msg.true_course)
                                if msg.true_course is not None else None)

    def read(self):
        with self.lock:
            return {
                "lat": self.lat, "lon": self.lon, "alt": self.alt,
                "speed": self.speed_kmh, "cog": self.cog,
                "sats": self.sats, "fix": self.fix,
            }