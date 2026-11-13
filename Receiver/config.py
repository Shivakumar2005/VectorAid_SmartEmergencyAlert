"""
Vector Aid - receiver configuration.

Radio and packet values are copied from the transmitter. If you change one
there, change it here. A mismatch produces silence, not an error.
"""

import os
import struct

# Load .env from THIS folder, whatever directory receiver.py is started from.
# python-dotenv is used if installed; otherwise a minimal reader does the same
# job, so a missing package can no longer silently drop the ORS key.
_ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
try:
    from dotenv import load_dotenv
    load_dotenv(_ENV_FILE)
except ImportError:
    if os.path.exists(_ENV_FILE):
        with open(_ENV_FILE) as _fh:
            for _line in _fh:
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

# ---------------------------------------------------------------- radio ----
CE_PIN = 22
CSN_PIN = 0
CHANNEL = 76
ADDRESS = b"1Node"

# --- telemetry packet (5 Hz), first byte is node_id ---
PACKET_FMT = "<BHiiHHHhBB"
# node_id, seq, lat*1e7, lon*1e7, speed*100, heading*100,
# route_bearing*100, altitude_m, flags, sats
PACKET_SIZE = struct.calcsize(PACKET_FMT)        # 21

# --- corridor chunk (1 Hz burst), first byte is the 0xC0 type marker ---
CORRIDOR_TYPE = 0xC0
CORRIDOR_POINTS_PER_CHUNK = 2
CORRIDOR_FMT = "<BBBBB" + "ii" * CORRIDOR_POINTS_PER_CHUNK
# type, version, chunk_index, chunk_total, n_points, 2 x (lat*1e7, lon*1e7)
CORRIDOR_SIZE = struct.calcsize(CORRIDOR_FMT)    # 21

assert PACKET_SIZE == CORRIDOR_SIZE == 21, "both packet types must be 21 bytes"

DATA_RATE_MBPS = 1
AUTO_ACK = False

# A corridor version older than this is treated as stale and dropped.
CORRIDOR_TIMEOUT_S = 5.0

# ------------------------------------------------------------------ gps ----
GPS_PORT = "/dev/serial0"
GPS_BAUD = 9600

# Indoor bench testing ONLY. When the receiver has no GPS fix, pretend the car
# is parked here so the whole alert pipeline can run indoors. A real fix
# always overrides it. Set back to None before any field test or demo.
# Example: (13.1265244, 79.9097467)
BENCH_CAR_POS = None

# ------------------------------------------------------------------ imu ----
IMU_ADDRESS = 0x68
IMU_SAMPLE_HZ = 50
HEADING_GPS_MIN_SPEED_MS = 1.5
GYRO_Z_BIAS_SAMPLES = 200

# -------------------------------------------------------------- matching ----
# True  : point-to-segment matching against the received corridor polyline
#         (the ESP32 behaviour, and what the deck describes)
# False : straight forward-ray approximation from route_bearing
# Thresholds, severity tiers and banner behaviour are identical either way -
# only the geometry underneath changes. Falls back to the ray automatically
# whenever no corridor has arrived yet.
USE_CORRIDOR_MATCHING = True

PATH_HALF_WIDTH_M = 30.0        # perpendicular offset counting as "in path"
CRITICAL_DISTANCE_M = 50.0      # in-path and closer than this = CRITICAL
MAX_ALERT_RANGE_M = 500.0

# Matches the ESP32 build: you must be more than this far behind the corridor
# start before it reports clear, so the alert does not flicker at the boundary.
BEHIND_HYSTERESIS_M = 5.0

SAME_DIRECTION_MAX_DEG = 60.0

# Once the ambulance has gone past this car it is hidden from the map (with
# its corridor). It only reappears if it approaches again: back in its path
# and at least this far ahead of it. The "passed" memory is cleared if the
# link is silent for PASSED_RESET_S (the ambulance has gone off air).
REAPPEAR_AHEAD_M = 15.0
PASSED_RESET_S = 30.0
OPPOSITE_DIRECTION_MIN_DEG = 120.0

LINK_TIMEOUT_S = 3.0

# ------------------------------------------------------- own route (ORS) ----
ORS_API_KEY = os.getenv("ORS_API_KEY")
ORS_URL = "https://api.openrouteservice.org/v2/directions/{profile}/geojson"
ORS_PROFILE = "driving-car"
ROUTE_CACHE = "route.json"

# Destination search-as-you-type. Uses the same ORS key. The free plan allows
# about 100 autocomplete requests a minute; the dashboard waits until you
# pause typing and needs 3+ letters, and repeated queries are cached.
ORS_AUTOCOMPLETE_URL = "https://api.openrouteservice.org/geocode/autocomplete"
SEARCH_COUNTRY = "IN"
SEARCH_RESULTS = 6

# ---------------------------------------------------------------- server ----
HTTP_HOST = "0.0.0.0"
HTTP_PORT = 9000
PUSH_HZ = 4                     # matches the transmitter's DASH_HZ

# ----------------------------------------------------------------- flags ----
FLAG_EMERGENCY = 0b00000001
FLAG_OFF_ROUTE = 0b00000010