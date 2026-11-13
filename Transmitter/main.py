import socket
import struct
import time

import packets
from geo import haversine_m

from pyrf24 import RF24, RF24_PA_LOW, RF24_1MBPS

import config
import dashboard
from imu import IMU 
from gps import GPS
from router import Route, load_route
from state import SharedState

PKT_SIZE = struct.calcsize(config.PACKET_FMT)


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


# ---------- radio ----------
radio = RF24(config.CE_PIN, config.CSN_PIN)
if not radio.begin():
    raise SystemExit("nRF24 not responding - check wiring")

radio.setPALevel(RF24_PA_LOW)
radio.setDataRate(RF24_1MBPS)
radio.setChannel(config.CHANNEL)
radio.setAutoAck(False)
radio.setPayloadSize(PKT_SIZE)
radio.stopListening(config.ADDRESS)

# ---------- sensors ----------
gps = GPS(config.GPS_PORT, config.GPS_BAUD)

imu = None
try:
    imu = IMU(addr=config.IMU_ADDR, calib_file=config.IMU_CALIB)
    if not imu.calibrated:
        print("WARNING: IMU not calibrated - run calibrate_imu.py")
except Exception as e:
    print(f"WARNING: IMU unavailable ({e}) - GPS course only")

# ---------- state + dashboard ----------
state = SharedState()

cached_pts, cached_sum = load_route(config.ROUTE_CACHE)
if cached_pts:
    print(f"Cached route found: {len(cached_pts)} points "
          f"({cached_sum['distance']/1000:.1f} km)")
    print("Confirm or replace it from the dashboard.")
    state.set_status("Cached route available - confirm on dashboard")

dashboard.start(state)

ip = local_ip()
print("\n" + "=" * 52)
print("  DASHBOARD READY")
print(f"    On this Pi   : http://localhost:{config.DASH_PORT}")
print(f"    From laptop  : http://{ip}:{config.DASH_PORT}")
print("=" * 52 + "\n")

# ---------- loop ----------
period = 1.0 / config.TX_HZ
corridor_period = 1.0 / config.CORRIDOR_TX_HZ

seq = sent = failed = chunks_sent = 0
route_obj = None
last_route_len = 0

corr_version = 0
corr_chunks = []
corr_anchor = None
corr_anchor_idx = None
last_corr_tx = 0.0

next_tick = time.time()
try:
    while True:
        f = gps.read()

        # rebuild the matcher whenever the dashboard sets a new route
        pts = state.get_route()
        if len(pts) != last_route_len:
            route_obj = Route(pts) if pts else None
            last_route_len = len(pts)

        if f["fix"] == 0 or f["lat"] is None:
            state.publish(fix=0, sats=f["sats"], tx_ok=False)
            state.set_status(f"No fix - {f['sats']} satellites visible")
            sleep_for = next_tick + period - time.time()
            if sleep_for > 0:
                time.sleep(sleep_for)
                next_tick += period
            else:
                next_tick = time.time()
            continue

        # heading: fused GPS + IMU
        if imu is not None:
            imu.feed_gps(f["speed"], f["cog"])
            m = imu.read()
            heading = m["heading"] if m["heading"] is not None else (f["cog"] or 0.0)
            src = m["source"]
        else:
            heading, src = (f["cog"] or 0.0), "gps"
            m = {"yaw_rate": 0.0, "accel_fwd": 0.0, "accel_lat": 0.0,
                 "roll": 0.0, "pitch": 0.0, "vibration": 0.0}

        route_brg, off_route, route_idx = (None, None, None)
        corridor = []
        if route_obj:
            route_brg, off_route, route_idx = route_obj.update(
                f["lat"], f["lon"], config.LOOKAHEAD_M)
            corridor = route_obj.corridor(f["lat"], f["lon"], config.CORRIDOR_M)

        tx_ok = False
        if state.tx_enabled and state.route_confirmed:
            flags = 0b00000001
            if off_route is not None and off_route > config.OFF_ROUTE_M:
                flags |= 0b00000010

            pkt = packets.pack_telemetry(
                config.NODE_ID, seq, f["lat"], f["lon"], f["speed"],
                heading, route_brg if route_brg is not None else heading,
                f["alt"] if f["alt"] is not None else 0, flags, f["sats"])
            tx_ok = radio.write(pkt)
            sent += 1
            if not tx_ok:
                failed += 1
            seq += 1

        # ---- corridor burst, once per second, after telemetry ----
        now = time.time()
        if (state.tx_enabled and state.route_confirmed
                and corridor and now - last_corr_tx >= corridor_period):

            advanced = (
                corr_anchor is None
                or route_idx != corr_anchor_idx
                or haversine_m(f["lat"], f["lon"],
                               corr_anchor[0], corr_anchor[1]) >= config.CORRIDOR_REBUILD_M
            )

            if advanced or not corr_chunks:
                corr_version = (corr_version + 1) & 0xFF
                corr_chunks = packets.build_corridor_chunks(corridor, corr_version)
                corr_anchor = (f["lat"], f["lon"])
                corr_anchor_idx = route_idx

            for ch in corr_chunks:
                if radio.write(ch):
                    chunks_sent += 1
                time.sleep(config.CORRIDOR_CHUNK_GAP)

            last_corr_tx = now

        state.publish(
            lat=f["lat"], lon=f["lon"], alt=f["alt"],
            speed=round(f["speed"], 1),
            heading=round(heading, 1), hdg_src=src,
            route_brg=round(route_brg, 1) if route_brg is not None else None,
            off_route=round(off_route) if off_route is not None else None,
            route_idx=route_idx,
            corridor=corridor,
            sats=f["sats"], fix=f["fix"],
            seq=seq, tx_ok=tx_ok, sent=sent, failed=failed,
            chunks_sent=chunks_sent,
            yaw_rate=round(m["yaw_rate"], 1),
            accel_fwd=round(m["accel_fwd"], 2),
            accel_lat=round(m["accel_lat"], 2),
            roll=round(m["roll"], 1),
            pitch=round(m["pitch"], 1),
            vibration=round(m["vibration"], 3),
        )

        if state.route_confirmed:
            state.set_status("Transmitting" if state.tx_enabled else "Transmit OFF")

        sleep_for = next_tick + period - time.time()
        if sleep_for > 0:
            time.sleep(sleep_for)
            next_tick += period
        else:
            next_tick = time.time()

except KeyboardInterrupt:
    print("\nStopped")
    radio.powerDown()
