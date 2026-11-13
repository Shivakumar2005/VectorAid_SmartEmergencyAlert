"""
Sensor threads for the receiver node.

Heading note, worth understanding before you present this:
the MPU6050 has an accelerometer and a gyroscope but NO magnetometer, so it
cannot know absolute north on its own. A free-running gyro integration drifts
several degrees a minute and is useless by itself.

So heading is speed-gated:
  moving      -> GPS course-over-ground is the truth, and we reset the gyro
                 estimate to it every fix
  slow/stopped-> GPS COG becomes noise, so we hold the last good heading and
                 integrate gyro Z to track turns until the car moves again

That gives a heading that is absolute when it can be and stable when it
cannot, without claiming a compass we do not have.
"""

import threading
import time

import serial
import pynmea2
from mpu6050 import mpu6050

import config


class GPSReader(threading.Thread):
    daemon = True

    def __init__(self):
        super().__init__(name="gps")
        self.lock = threading.Lock()
        self.lat = None
        self.lon = None
        self.speed_ms = 0.0
        self.course = None
        self.satellites = 0
        self.fix = False
        self.last_fix_time = 0.0
        self._stop_event = threading.Event()

    def run(self):
        while not self._stop_event.is_set():
            try:
                port = serial.Serial(config.GPS_PORT, config.GPS_BAUD,
                                     timeout=1)
            except Exception as exc:
                print("[gps] cannot open %s: %s" % (config.GPS_PORT, exc))
                time.sleep(2)
                continue

            try:
                while not self._stop_event.is_set():
                    raw = port.readline().decode("ascii", errors="replace").strip()
                    if not raw.startswith("$"):
                        continue
                    try:
                        msg = pynmea2.parse(raw)
                    except pynmea2.ParseError:
                        continue
                    self._consume(msg)
            except Exception as exc:
                print("[gps] read error: %s" % exc)
                time.sleep(1)
            finally:
                try:
                    port.close()
                except Exception:
                    pass

    def _consume(self, msg):
        kind = msg.sentence_type if hasattr(msg, "sentence_type") else ""
        with self.lock:
            if kind == "RMC":
                self.fix = (getattr(msg, "status", "V") == "A")
                if self.fix and msg.latitude and msg.longitude:
                    self.lat = msg.latitude
                    self.lon = msg.longitude
                    self.last_fix_time = time.time()
                    knots = msg.spd_over_grnd or 0.0
                    self.speed_ms = float(knots) * 0.514444
                    cog = msg.true_course
                    self.course = float(cog) if cog is not None else None
            elif kind == "GGA":
                try:
                    self.satellites = int(msg.num_sats or 0)
                except (TypeError, ValueError):
                    self.satellites = 0

    def snapshot(self):
        with self.lock:
            return {
                "lat": self.lat,
                "lon": self.lon,
                "speed_ms": self.speed_ms,
                "course": self.course,
                "satellites": self.satellites,
                "fix": self.fix,
                "age_s": (time.time() - self.last_fix_time
                          if self.last_fix_time else None),
            }

    def stop(self):
        self._stop_event.set()


class HeadingEstimator(threading.Thread):
    """Fuses GPS course-over-ground with gyro Z integration."""

    daemon = True

    def __init__(self, gps: GPSReader):
        super().__init__(name="heading")
        self.gps = gps
        self.lock = threading.Lock()
        self.heading = None
        self.source = "none"
        self.turn_rate = 0.0
        self.gyro_bias = 0.0
        self.imu_ok = False
        self._sensor = None
        self._stop_event = threading.Event()

    def _calibrate(self):
        """Average gyro Z at rest to remove constant bias. Keep the car still."""
        print("[imu] calibrating gyro bias - keep the unit still...")
        total = 0.0
        taken = 0
        for _ in range(config.GYRO_Z_BIAS_SAMPLES):
            try:
                total += self._sensor.get_gyro_data()["z"]
                taken += 1
            except Exception:
                pass
            time.sleep(0.005)
        self.gyro_bias = total / taken if taken else 0.0
        print("[imu] gyro Z bias = %.3f deg/s" % self.gyro_bias)

    def run(self):
        try:
            self._sensor = mpu6050(config.IMU_ADDRESS)
            self._calibrate()
            self.imu_ok = True
        except Exception as exc:
            print("[imu] unavailable (%s) - falling back to GPS-only heading" % exc)
            self.imu_ok = False

        period = 1.0 / config.IMU_SAMPLE_HZ
        last = time.time()

        while not self._stop_event.is_set():
            now = time.time()
            dt = now - last
            last = now

            fix = self.gps.snapshot()
            moving = (fix["fix"]
                      and fix["speed_ms"] >= config.HEADING_GPS_MIN_SPEED_MS
                      and fix["course"] is not None)

            rate = 0.0
            if self.imu_ok:
                try:
                    rate = self._sensor.get_gyro_data()["z"] - self.gyro_bias
                except Exception:
                    rate = 0.0

            with self.lock:
                self.turn_rate = rate
                if moving:
                    # GPS wins outright while moving.
                    self.heading = fix["course"]
                    self.source = "gps"
                elif self.heading is not None and self.imu_ok:
                    # Hold and integrate turns while slow or stopped.
                    self.heading = (self.heading + rate * dt) % 360.0
                    self.source = "gyro-hold"
                elif self.heading is None and fix["course"] is not None:
                    self.heading = fix["course"]
                    self.source = "gps"

            time.sleep(max(0.0, period - (time.time() - now)))

    def snapshot(self):
        with self.lock:
            return {
                "heading": self.heading,
                "source": self.source,
                "turn_rate": self.turn_rate,
                "imu_ok": self.imu_ok,
            }

    def stop(self):
        self._stop_event.set()