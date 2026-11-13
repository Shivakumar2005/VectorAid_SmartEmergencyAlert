"""
nRF24L01 receive thread.

Settings mirror the transmitter: channel 76, address b"1Node", 1 MBPS,
auto-ack off, CRC-16, 21-byte static payload.

Uses the snake_case pyrf24 API - the same calls already proven on this board
during the bring-up link test.

Corridor chunks are staged by version and only promoted once every chunk of
that version has arrived, so a half-received polyline never reaches the alert
logic or the map.
"""

import threading
import time

from pyrf24 import RF24, RF24_PA_LOW, RF24_1MBPS, RF24_CRC_16

import config
import packets


class RadioLink(threading.Thread):
    daemon = True

    def __init__(self):
        super().__init__(name="radio")
        self.lock = threading.Lock()

        self.telemetry = None
        self.telemetry_time = 0.0

        self.corridor = []
        self.corridor_version = None
        self.corridor_time = 0.0
        self._staging = {}

        self.received = 0
        self.corridor_chunks = 0
        self.unknown = 0
        self.missed = 0
        self.last_seq = None
        self.strong_signal = False
        self.error = None

        self._unknown_logged = 0
        self._radio = None
        self._stop_event = threading.Event()

    def _open(self):
        radio = RF24(config.CE_PIN, config.CSN_PIN)
        if not radio.begin():
            raise RuntimeError("nRF24L01 not responding - check wiring/power")
        if not radio.is_chip_connected:
            raise RuntimeError("SPI answers but no nRF24 chip - check MISO/CSN")

        radio.set_pa_level(RF24_PA_LOW)
        radio.data_rate = RF24_1MBPS
        radio.channel = config.CHANNEL
        radio.crc_length = RF24_CRC_16
        radio.set_auto_ack(config.AUTO_ACK)
        radio.dynamic_payloads = False
        radio.payload_size = config.PACKET_SIZE
        radio.open_rx_pipe(1, config.ADDRESS)
        radio.listen = True

        # Read the settings BACK from the chip, so the log shows what the
        # radio is really doing rather than what we asked for.
        print("[radio] ch=%d  rate=%s  crc=%s  payload=%d  addr=%s  listening"
              % (radio.channel, radio.data_rate, radio.crc_length,
                 radio.payload_size, config.ADDRESS.decode()))
        return radio

    def run(self):
        try:
            self._radio = self._open()
        except Exception as exc:
            self.error = str(exc)
            print("[radio] %s" % exc)
            return

        last_report = time.time()
        while not self._stop_event.is_set():
            try:
                if self._radio.available():
                    raw = bytes(self._radio.read(config.PACKET_SIZE))
                    self._on_packet(raw)
                    # Signal-strength probe is optional. If it ever fails it
                    # must NOT stop the packet we already read from counting.
                    try:
                        self.strong_signal = bool(self._radio.rpd)
                    except Exception:
                        pass
                else:
                    time.sleep(0.002)
            except Exception as exc:
                print("[radio] read error: %s" % exc)
                time.sleep(0.5)

            if time.time() - last_report >= 10.0:
                last_report = time.time()
                with self.lock:
                    print("[radio] 10s: telemetry=%d corridor_chunks=%d "
                          "undecodable=%d"
                          % (self.received, self.corridor_chunks,
                             self.unknown))

    def _on_packet(self, raw):
        decoded = packets.decode(raw)
        kind = decoded.get("type")

        with self.lock:
            if kind == "telemetry":
                self.received += 1
                seq = decoded["seq"]
                if self.last_seq is not None:
                    gap = (seq - self.last_seq) & 0xFFFF
                    if 1 < gap < 1000:
                        self.missed += gap - 1
                self.last_seq = seq
                self.telemetry = decoded
                self.telemetry_time = time.time()

            elif kind == "corridor":
                self.corridor_chunks += 1
                self._stage(decoded)

            else:
                self.unknown += 1
                if self._unknown_logged < 5:
                    self._unknown_logged += 1
                    print("[radio] undecodable packet (%s): len=%d  %s"
                          % (decoded.get("reason", "?"),
                             decoded.get("length", 0),
                             decoded.get("hex", "")))

    def _stage(self, chunk):
        version = chunk["version"]
        if version == self.corridor_version:
            # A repeat of the corridor we already hold. The transmitter only
            # bumps the version after moving 10 m, so while the ambulance is
            # parked every burst is a repeat - it must still count as fresh,
            # or the corridor would vanish after CORRIDOR_TIMEOUT_S.
            self.corridor_time = time.time()
            return

        bucket = self._staging.setdefault(version, {})
        bucket[chunk["index"]] = chunk["points"]

        if len(bucket) >= chunk["total"]:
            ordered = []
            for i in range(chunk["total"]):
                ordered.extend(bucket.get(i, []))
            self.corridor = ordered
            self.corridor_version = version
            self.corridor_time = time.time()
            self._staging.clear()

        if len(self._staging) > 4:
            self._staging.pop(sorted(self._staging)[0], None)

    def snapshot(self):
        with self.lock:
            now = time.time()
            age = now - self.telemetry_time if self.telemetry_time else None
            corridor_age = (now - self.corridor_time
                            if self.corridor_time else None)
            fresh = (corridor_age is not None
                     and corridor_age <= config.CORRIDOR_TIMEOUT_S)
            expected = self.received + self.missed
            return {
                "up": age is not None and age <= config.LINK_TIMEOUT_S,
                "age_s": age,
                "telemetry": dict(self.telemetry) if self.telemetry else None,
                "corridor": list(self.corridor) if fresh else [],
                "corridor_version": self.corridor_version if fresh else None,
                "corridor_age_s": corridor_age,
                "received": self.received,
                "corridor_chunks": self.corridor_chunks,
                "missed": self.missed,
                "unknown": self.unknown,
                "loss_pct": (self.missed / expected * 100.0) if expected else 0.0,
                "strong_signal": self.strong_signal,
                "error": self.error,
            }

    def stop(self):
        self._stop_event.set()