import json
import math
import os
import threading
import time

import smbus2

# MPU-6050 registers
PWR_MGMT_1   = 0x6B
SMPLRT_DIV   = 0x19
CONFIG       = 0x1A
GYRO_CONFIG  = 0x1B
ACCEL_CONFIG = 0x1C
ACCEL_XOUT_H = 0x3B
WHO_AM_I     = 0x75

ACCEL_SCALE = 8192.0    # +/- 4 g
GYRO_SCALE  = 131.0     # +/- 250 dps


def _wrap(a):
    return (a + 360.0) % 360.0


def _diff(a, b):
    """Shortest signed angular difference a - b, in -180..180."""
    d = (a - b + 180.0) % 360.0 - 180.0
    return d


class IMU:
    """MPU-6050 with GPS-aided heading.

    Heading comes from GPS course when moving fast enough to trust it,
    and from integrated gyro yaw when too slow. Gyro bias is re-estimated
    whenever the vehicle is stationary.
    """

    GPS_TRUST_KMH = 8.0     # above this, GPS course is authoritative
    STILL_GYRO    = 1.0     # deg/s - below this counts as stationary
    ALPHA         = 0.02    # how hard GPS pulls the fused heading

    def __init__(self, addr=0x68, bus=1, calib_file="imu_calib.json"):
        self.bus = smbus2.SMBus(bus)
        self.addr = addr

        who = self.bus.read_byte_data(addr, WHO_AM_I)
        if who not in (0x68, 0x70, 0x71, 0x73):
            raise RuntimeError(f"Unexpected WHO_AM_I 0x{who:02x} at 0x{addr:02x}")

        self.bus.write_byte_data(addr, PWR_MGMT_1, 0x00)      # wake
        time.sleep(0.1)
        self.bus.write_byte_data(addr, PWR_MGMT_1, 0x01)      # gyro X as clock
        self.bus.write_byte_data(addr, CONFIG, 0x03)          # DLPF ~44 Hz
        self.bus.write_byte_data(addr, SMPLRT_DIV, 0x04)      # 200 Hz
        self.bus.write_byte_data(addr, GYRO_CONFIG, 0x00)     # +/- 250 dps
        self.bus.write_byte_data(addr, ACCEL_CONFIG, 0x08)    # +/- 4 g
        time.sleep(0.05)

        self.gbias = {"x": 0.0, "y": 0.0, "z": 0.0}
        self.calibrated = False
        if os.path.exists(calib_file):
            with open(calib_file) as f:
                self.gbias = json.load(f)["gyro_bias"]
            self.calibrated = True

        self._lock = threading.Lock()
        self.heading = None          # fused, degrees 0-360
        self.yaw_rate = 0.0          # deg/s, +ve = turning right
        self.accel_fwd = 0.0         # m/s2 along X
        self.accel_lat = 0.0         # m/s2 along Y
        self.roll = 0.0
        self.pitch = 0.0
        self.vibration = 0.0
        self.source = "none"         # gps | imu | none

        self._gps_speed = 0.0
        self._gps_cog = None
        self._last_gps_hdg = None
        self._still_since = None

        self._running = True
        threading.Thread(target=self._loop, daemon=True).start()

    # ---------- raw ----------
    def _read_raw(self):
        d = self.bus.read_i2c_block_data(self.addr, ACCEL_XOUT_H, 14)

        def s16(hi, lo):
            v = (d[hi] << 8) | d[lo]
            return v - 65536 if v > 32767 else v

        ax, ay, az = s16(0, 1), s16(2, 3), s16(4, 5)
        gx, gy, gz = s16(8, 9), s16(10, 11), s16(12, 13)
        return (ax / ACCEL_SCALE, ay / ACCEL_SCALE, az / ACCEL_SCALE,
                gx / GYRO_SCALE, gy / GYRO_SCALE, gz / GYRO_SCALE)

    # ---------- fusion ----------
    def _loop(self):
        last = time.time()
        acc_hist = []

        while self._running:
            try:
                ax, ay, az, gx, gy, gz = self._read_raw()
            except OSError:
                time.sleep(0.01)
                continue

            now = time.time()
            dt = now - last
            last = now
            if dt <= 0 or dt > 0.5:
                time.sleep(0.005)
                continue

            gx -= self.gbias["x"]
            gy -= self.gbias["y"]
            gz -= self.gbias["z"]

            # tilt from gravity
            roll = math.atan2(ay, az)
            pitch = math.atan2(-ax, math.sqrt(ay * ay + az * az))

            # yaw rate projected onto the earth vertical
            cp = math.cos(pitch)
            yaw_rate = ((gy * math.sin(roll) + gz * math.cos(roll)) / cp
                        if abs(cp) > 0.1 else gz)

            # stationary detection -> re-learn gyro bias
            moving_gyro = max(abs(gx), abs(gy), abs(gz))
            if moving_gyro < self.STILL_GYRO and self._gps_speed < 1.0:
                if self._still_since is None:
                    self._still_since = now
                elif now - self._still_since > 2.0:
                    k = 0.001
                    self.gbias["x"] += k * gx
                    self.gbias["y"] += k * gy
                    self.gbias["z"] += k * gz
            else:
                self._still_since = None

            # ---- heading ----
            with self._lock:
                h = self.heading
                spd = self._gps_speed
                cog = self._gps_cog

            if spd >= self.GPS_TRUST_KMH and cog is not None:
                if h is None:
                    h = cog
                else:
                    h = _wrap(h + yaw_rate * dt)
                    h = _wrap(h + self.ALPHA * _diff(cog, h))
                src = "gps"
                self._last_gps_hdg = h
            elif h is not None:
                h = _wrap(h + yaw_rate * dt)
                src = "imu"
            else:
                src = "none"

            # vibration = short-window accel magnitude spread
            mag = math.sqrt(ax * ax + ay * ay + az * az)
            acc_hist.append(mag)
            if len(acc_hist) > 50:
                acc_hist.pop(0)
            vib = (max(acc_hist) - min(acc_hist)) if len(acc_hist) > 10 else 0.0

            with self._lock:
                self.heading = h
                self.source = src
                self.yaw_rate = yaw_rate
                self.accel_fwd = ax * 9.80665
                self.accel_lat = ay * 9.80665
                self.roll = math.degrees(roll)
                self.pitch = math.degrees(pitch)
                self.vibration = vib

            time.sleep(0.005)      # ~200 Hz

    # ---------- interface ----------
    def feed_gps(self, speed_kmh, cog):
        with self._lock:
            self._gps_speed = speed_kmh
            self._gps_cog = cog

    def read(self):
        with self._lock:
            return {
                "heading": self.heading,
                "source": self.source,
                "yaw_rate": self.yaw_rate,
                "accel_fwd": self.accel_fwd,
                "accel_lat": self.accel_lat,
                "roll": self.roll,
                "pitch": self.pitch,
                "vibration": self.vibration,
            }