#!/usr/bin/env python3
"""
Transmitter simulator.

Run this on the OTHER Pi to exercise the receiver before the real transmitter
firmware is finished. It drives a synthetic ambulance along a straight route
and broadcasts exactly the packet format the real transmitter must use, so it
doubles as a reference implementation of the send side.

    python3 tx_simulator.py

Edit ROUTE_START / ROUTE_END for your test location.
"""

import math
import time

from pyrf24 import RF24, RF24_PA_LOW, RF24_250KBPS

import config
import packets

AMB_ID = "AMB01"
ROUTE_START = (11.6643, 78.1460)   # Salem - change to your test area
ROUTE_END = (11.6720, 78.1560)
NUM_WAYPOINTS = 12
SPEED_MS = 12.0                    # ~43 km/h
TELEMETRY_HZ = 5
CORRIDOR_PERIOD_S = 1.0


def interpolate(a, b, count):
    return [(a[0] + (b[0] - a[0]) * i / (count - 1),
             a[1] + (b[1] - a[1]) * i / (count - 1))
            for i in range(count)]


def bearing(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def main():
    radio = RF24(config.CE_PIN, config.CSN_PIN)
    if not radio.begin():
        raise SystemExit("nRF24L01 not responding")
    radio.set_pa_level(RF24_PA_LOW)
    radio.data_rate = RF24_250KBPS
    radio.channel = config.RF_CHANNEL
    radio.payload_size = config.PAYLOAD_SIZE
    radio.open_tx_pipe(config.RF_ADDRESS)
    radio.listen = False

    route = interpolate(ROUTE_START, ROUTE_END, NUM_WAYPOINTS)
    heading = bearing(ROUTE_START, ROUTE_END)
    chunks = packets.build_corridor_chunks(1, route)

    print("Simulating %s along %d waypoints on channel %d"
          % (AMB_ID, len(route), config.RF_CHANNEL))

    seq = 0
    progress = 0.0
    last_corridor = 0.0
    interval = 1.0 / TELEMETRY_HZ

    try:
        while True:
            now = time.time()

            # Resend the corridor once a second so a receiver that joins late
            # still gets the route.
            if now - last_corridor >= CORRIDOR_PERIOD_S:
                last_corridor = now
                for chunk in chunks:
                    radio.write(chunk)
                    time.sleep(0.004)

            progress = (progress + SPEED_MS * interval / 1200.0) % 1.0
            lat = ROUTE_START[0] + (ROUTE_END[0] - ROUTE_START[0]) * progress
            lon = ROUTE_START[1] + (ROUTE_END[1] - ROUTE_START[1]) * progress

            packet = packets.encode_telemetry(
                AMB_ID, lat, lon, heading, SPEED_MS, 1, seq)
            ok = radio.write(packet)
            if seq % TELEMETRY_HZ == 0:
                print("seq %3d  %.5f, %.5f  %s"
                      % (seq, lat, lon, "ACK" if ok else "no ack"))
            seq = (seq + 1) % 256
            time.sleep(interval)
    except KeyboardInterrupt:
        radio.power = False
        print("\nStopped.")


if __name__ == "__main__":
    main()