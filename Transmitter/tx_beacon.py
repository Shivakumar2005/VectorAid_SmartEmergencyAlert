#!/usr/bin/env python3
"""
tx_beacon.py - run on the TRANSMITTER Pi, instead of main.py.

Sends correctly formatted packets with fake coordinates. No GPS fix, no
transmit button, no ORS, no dashboard - nothing can gate it. Self-contained:
it imports nothing from the transmitter project, so it cannot inherit a
broken setting from there.

  If the receiver sees THESE packets but not main.py's, the radio link is
  fine and the problem is inside main.py (gating, GPS wait, button).

  If the receiver sees nothing even from this, the problem is the radio
  hardware: power, distance, or the module itself.

    python3 tx_beacon.py        (stop main.py first - one owner per radio)
"""

import math
import struct
import time

from pyrf24 import RF24, RF24_PA_LOW, RF24_1MBPS, RF24_CRC_16

# ---- must match both sides exactly ----
CE_PIN, CSN_PIN = 22, 0
CHANNEL = 76
ADDRESS = b"1Node"
PACKET_FMT = "<BHiiHHHhBB"            # 21 bytes, telemetry
CORRIDOR_FMT = "<BBBBB" + "ii" * 2    # 21 bytes, corridor chunk
CORRIDOR_TYPE = 0xC0
NODE_ID = 1

# a fake ambulance, parked near Chennai Central
LAT, LON = 13.0827, 80.2707
ROUTE_BEARING = 120.0


def offset(lat, lon, bearing, metres):
    r = 6371008.8
    d, b = metres / r, math.radians(bearing)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d)
                   + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1),
                         math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def corridor_chunks(version):
    pts = [offset(LAT, LON, ROUTE_BEARING, 100.0 * i / 11) for i in range(12)]
    groups = [pts[i:i + 2] for i in range(0, len(pts), 2)]
    out = []
    for i, g in enumerate(groups):
        coords = []
        for j in range(2):
            if j < len(g):
                coords += [int(round(g[j][0] * 1e7)), int(round(g[j][1] * 1e7))]
            else:
                coords += [0, 0]
        out.append(struct.pack(CORRIDOR_FMT, CORRIDOR_TYPE, version & 0xFF,
                               i, len(groups), len(g), *coords))
    return out


def main():
    radio = RF24(CE_PIN, CSN_PIN)
    if not radio.begin():
        raise SystemExit("nRF24 not responding - check wiring/power")
    if not radio.is_chip_connected:
        raise SystemExit("SPI answers but no chip - check MISO/CSN")

    radio.set_pa_level(RF24_PA_LOW)
    radio.data_rate = RF24_1MBPS
    radio.channel = CHANNEL
    radio.crc_length = RF24_CRC_16
    radio.set_auto_ack(False)
    radio.dynamic_payloads = False
    radio.payload_size = struct.calcsize(PACKET_FMT)
    radio.stop_listening(ADDRESS)

    radio.print_pretty_details()
    print("\nBeaconing on ch%d, 21-byte packets. Ctrl+C to stop.\n" % CHANNEL)

    chunks = corridor_chunks(1)
    seq = 0
    last_corridor = 0.0
    next_tick = time.time()
    try:
        while True:
            pkt = struct.pack(PACKET_FMT, NODE_ID, seq & 0xFFFF,
                              int(LAT * 1e7), int(LON * 1e7),
                              int(30.0 * 100), int(ROUTE_BEARING * 100),
                              int(ROUTE_BEARING * 100), 12,
                              0b00000001, 9)
            radio.write(pkt)
            # With auto-ack off write() returns True once the packet leaves;
            # it cannot tell us whether anyone heard it.

            now = time.time()
            if now - last_corridor >= 1.0:
                last_corridor = now
                for c in chunks:
                    radio.write(c)
                    time.sleep(0.003)

            if seq % 25 == 0:
                print("sent telemetry seq=%d (+ corridor bursts)" % seq)
            seq += 1
            next_tick += 0.2
            time.sleep(max(0.0, next_tick - time.time()))
    except KeyboardInterrupt:
        radio.power = False
        print("\nstopped after %d packets" % seq)


if __name__ == "__main__":
    main()