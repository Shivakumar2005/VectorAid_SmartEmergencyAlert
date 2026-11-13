"""Run once, with the board completely still on a flat surface."""
import json
import time

from imu import IMU
import config

print("Place the board flat and DO NOT TOUCH IT.")
input("Press Enter when ready...")

imu = IMU(addr=config.IMU_ADDR, calib_file="__none__")
time.sleep(0.5)

n = 0
sx = sy = sz = 0.0
t0 = time.time()

print("\nSampling for 15 seconds...")
while time.time() - t0 < 15:
    _, _, _, gx, gy, gz = imu._read_raw()
    sx += gx
    sy += gy
    sz += gz
    n += 1
    print(f"\r  {n:5d} samples", end="")
    time.sleep(0.01)

bias = {"x": sx / n, "y": sy / n, "z": sz / n} 

with open(config.IMU_CALIB, "w") as f:
    json.dump({"gyro_bias": bias}, f, indent=2)

print(f"\n\nSaved to {config.IMU_CALIB}")
print(f"  gyro bias (deg/s): x={bias['x']:+.3f}  y={bias['y']:+.3f}  z={bias['z']:+.3f}")

if max(abs(v) for v in bias.values()) > 5.0:
    print("\n  WARNING: bias is unusually large. Was the board moving?")
