import os
from dotenv import load_dotenv

load_dotenv()

# --- Radio ---
CE_PIN = 22
CSN_PIN = 0
CHANNEL = 76
ADDRESS = b"1Node"
NODE_ID = 1
CORRIDOR_M = 100.0

# 21-byte packet
PACKET_FMT = "<BHiiHHHhBB"

# --- Corridor broadcast (second packet type, also exactly 21 bytes) ---
CORRIDOR_FMT   = "<BBBBB" + "ii" * 2      # 5 + 16 = 21
CORRIDOR_TYPE  = 0xC0                     # byte 0 marker; telemetry uses node_id=1

CORRIDOR_M            = 100.0   # window length - change to 250.0 later, nothing else
CORRIDOR_MAX_POINTS   = 12      # downsample cap -> at most 6 chunks
CORRIDOR_TX_HZ        = 1.0     # full corridor resent once per second
CORRIDOR_CHUNK_GAP    = 0.003   # 3 ms between chunk writes
CORRIDOR_REBUILD_M    = 10.0    # move this far -> new version

LOOKAHEAD_M = 50.0              # route_bearing target distance ahead
# node_id, seq, lat*1e7, lon*1e7, speed*100, heading*100,
# route_bearing*100, altitude_m, flags, sats

# --- GPS ---
GPS_PORT = "/dev/serial0"
GPS_BAUD = 9600

# --- IMU (MPU-6050 / HW-123) ---
IMU_ADDR = 0x68
IMU_CALIB = "imu_calib.json"
GPS_TRUST_KMH = 8.0

# --- Route ---
ORS_API_KEY = os.getenv("ORS_API_KEY")
ROUTE_CACHE = "route.json"
OFF_ROUTE_M = 50

# --- Loop rates ---
TX_HZ = 5
DASH_HZ = 4

# --- Dashboard ---
DASH_HOST = "0.0.0.0"
DASH_PORT = 8000