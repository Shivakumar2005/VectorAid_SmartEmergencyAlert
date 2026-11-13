#!/usr/bin/env python3
"""
rf_doctor.py - run on the RECEIVER Pi when nothing is being detected.

Works indoors, needs no GPS. Stop receiver.py first (only one program may own
the radio). Answers three questions in order:

  1. Is this radio chip healthy and configured the way we think?
  2. Is ANY radio energy on the air - and on which channel?
  3. If energy is there but no packets decode, which setting is mismatched?

    python3 rf_doctor.py
"""

import time

from pyrf24 import (RF24, RF24_PA_LOW, RF24_250KBPS, RF24_1MBPS, RF24_2MBPS,
                    RF24_CRC_16)

import config
import packets

RATES = {RF24_250KBPS: "250KBPS", RF24_1MBPS: "1MBPS", RF24_2MBPS: "2MBPS"}


def line(title):
    print("\n" + "=" * 64 + "\n" + title + "\n" + "=" * 64)


def configure(radio, rate, auto_ack):
    radio.listen = False
    radio.set_pa_level(RF24_PA_LOW)
    radio.data_rate = rate
    radio.channel = config.CHANNEL
    radio.crc_length = RF24_CRC_16
    radio.set_auto_ack(auto_ack)
    radio.dynamic_payloads = False
    radio.payload_size = config.PACKET_SIZE
    radio.open_rx_pipe(1, config.ADDRESS)
    radio.flush_rx()
    radio.listen = True


def listen_for(radio, seconds, show=3):
    counts = {"telemetry": 0, "corridor": 0, "unknown": 0}
    shown = 0
    end = time.time() + seconds
    while time.time() < end:
        if radio.available():
            raw = bytes(radio.read(config.PACKET_SIZE))
            d = packets.decode(raw)
            counts[d["type"]] = counts.get(d["type"], 0) + 1
            if shown < show:
                shown += 1
                print("   %-9s %s" % (d["type"], raw.hex(" ")))
                if d["type"] == "telemetry":
                    print("             node=%d seq=%d  %.6f,%.6f  alt=%dm  "
                          "sats=%d  emergency=%s"
                          % (d["node_id"], d["seq"], d["lat"], d["lon"],
                             d["altitude_m"], d["sats"], d["emergency"]))
                elif d["type"] == "corridor":
                    print("             version=%d chunk %d/%d, %d pts"
                          % (d["version"], d["index"] + 1, d["total"],
                             len(d["points"])))
                else:
                    print("             reason: %s" % d.get("reason"))
        else:
            time.sleep(0.001)
    return counts


def main():
    radio = RF24(config.CE_PIN, config.CSN_PIN)

    # ------------------------------------------------------------ step 1 --
    line("STEP 1  chip health")
    if not radio.begin():
        print("FAIL  begin() returned False - wiring or power fault.")
        return
    if not radio.is_chip_connected:
        print("FAIL  SPI answers but no chip - check MISO (pin 21) and CSN (pin 24).")
        return
    radio.channel = 99
    if radio.channel != 99:
        print("FAIL  register write/readback failed - SPI is unreliable.")
        return
    print("OK    chip connected, register readback works")
    print("      plus variant: %s" % radio.is_plus_variant)

    configure(radio, RF24_1MBPS, config.AUTO_ACK)
    print("\n      settings read back from the chip:")
    radio.print_pretty_details()

    # ------------------------------------------------------------ step 2 --
    line("STEP 2  is anything transmitting?  (carrier scan, ~10 s)")
    print("      Make sure the transmitter is running AND transmitting now.")
    radio.set_auto_ack(False)
    hits = [0] * 126
    sweeps = 40
    for _ in range(sweeps):
        for ch in range(126):
            radio.channel = ch
            radio.listen = True
            time.sleep(0.0002)            # RPD needs >170 us in RX
            if radio.rpd:
                hits[ch] += 1
            radio.listen = False
    busy = sorted(((h, ch) for ch, h in enumerate(hits) if h), reverse=True)
    if not busy:
        print("NONE  no radio energy above -64 dBm on any channel.")
        print("      -> The transmitter is not putting anything on the air.")
        print("         Check: TX program running? Transmit button ON?")
        print("         Waiting for a GPS fix (indoors)? TX radio powered?")
    else:
        print("      strongest channels (hits out of %d sweeps):" % sweeps)
        for h, ch in busy[:8]:
            tag = "  <-- our channel" if ch == config.CHANNEL else ""
            wifi = "  (Wi-Fi band overlap)" if 0 <= ch <= 83 and h == sweeps else ""
            print("      ch %3d : %2d%s%s" % (ch, h, tag, wifi))
        if hits[config.CHANNEL] == 0:
            print("\nWARN  energy seen, but NOT on channel %d." % config.CHANNEL)
            print("      Either the transmitter is on another channel, or it")
            print("      is not transmitting and this is Wi-Fi/Bluetooth.")

    # ------------------------------------------------------------ step 3 --
    line("STEP 3  listen with the correct settings (15 s)")
    configure(radio, RF24_1MBPS, config.AUTO_ACK)
    counts = listen_for(radio, 15)
    print("\n      telemetry=%d  corridor=%d  undecodable=%d"
          % (counts["telemetry"], counts["corridor"], counts["unknown"]))
    if counts["telemetry"] or counts["corridor"]:
        print("\nPASS  link works. If receiver.py still shows nothing, the")
        print("      problem is above the radio - tell Claude what it prints.")
        radio.power = False
        return
    if counts["unknown"]:
        print("\nFAIL  packets arrive but do not decode - format mismatch.")
        print("      Send Claude the hex lines above.")
        radio.power = False
        return

    # ------------------------------------------------------------ step 4 --
    line("STEP 4  nothing decoded - trying other settings (6 s each)")
    found = False
    for rate in (RF24_1MBPS, RF24_250KBPS, RF24_2MBPS):
        for ack in (False, True):
            if rate == RF24_1MBPS and ack == config.AUTO_ACK:
                continue                  # already tried in step 3
            configure(radio, rate, ack)
            c = listen_for(radio, 6, show=1)
            total = sum(c.values())
            print("      %-8s auto-ack=%-5s -> %d packets"
                  % (RATES[rate], ack, total))
            if total:
                found = True
                print("\nFOUND  the transmitter is using %s with auto-ack %s."
                      % (RATES[rate], "ON" if ack else "OFF"))
                print("       Match it in config.py, or fix the transmitter.")
                break
        if found:
            break
    if not found:
        print("\nFAIL  no packets at any data rate. Most likely, in order:")
        print("   1. transmitter not transmitting (button off / no GPS fix)")
        print("   2. radios too CLOSE - two PA+LNA modules within ~1 m")
        print("      saturate each other's receiver. Move them 2-3 m apart.")
        print("   3. address or payload-size mismatch on the transmitter")
        print("   4. transmitter radio under-powered (needs its own 3.3 V")
        print("      or the adaptor on 5 V, plus a 10 uF cap)")
        print("   Run tx_beacon.py on the transmitter to rule out 1 and 3.")

    radio.power = False


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped")