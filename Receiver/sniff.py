#!/usr/bin/env python3
"""
Link test. Run this BEFORE receiver.py.

Prints every packet that arrives, raw and decoded. Needs no GPS fix, so it
works indoors - which is the point. If this shows packets, the radio pair is
proven and any remaining problem is on the GPS side.
"""

import time

from pyrf24 import RF24, RF24_PA_LOW, RF24_1MBPS, RF24_CRC_16

import config
import packets

radio = RF24(config.CE_PIN, config.CSN_PIN)
if not radio.begin():
    raise SystemExit("nRF24 not responding - check wiring and power")

radio.setPALevel(RF24_PA_LOW)
radio.setDataRate(RF24_1MBPS)
radio.setChannel(config.CHANNEL)
radio.setCRCLength(RF24_CRC_16)
radio.setAutoAck(config.AUTO_ACK)
radio.setPayloadSize(config.PACKET_SIZE)
radio.openReadingPipe(1, config.ADDRESS)
radio.startListening()

radio.print_pretty_details()
print("\nListening on ch%d, %d-byte payload. Start the transmitter now.\n"
      % (config.CHANNEL, config.PACKET_SIZE))

count = 0
started = time.time()
try:
    while True:
        if radio.available():
            raw = bytes(radio.read(config.PACKET_SIZE))
            count += 1
            d = packets.decode(raw)
            print("#%d  %s" % (count, raw.hex(" ")))
            if d:
                print("    node=%d seq=%d  %.6f, %.6f  %.1f km/h  "
                      "hdg=%.1f  route=%.1f  sats=%d  emg=%s"
                      % (d["node_id"], d["seq"], d["lat"], d["lon"],
                         d["speed_kmh"], d["heading"], d["route_bearing"],
                         d["sats"], d["emergency"]))
            else:
                print("    could not decode - payload size mismatch?")
        else:
            time.sleep(0.002)
            if count == 0 and time.time() - started > 15:
                started = time.time()
                print("...nothing yet. Check the transmitter is running and "
                      "that channel, address, data rate and payload size "
                      "match on both sides.")
except KeyboardInterrupt:
    print("\n%d packets received." % count)
    radio.powerDown()