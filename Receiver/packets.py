"""
Packet decoding.

Two 21-byte packet types share the air, told apart by byte 0:
  byte 0 == 0xC0  -> corridor chunk
  otherwise       -> telemetry, where byte 0 is node_id

Anything that does not decode is returned as an "unknown" record carrying its
hex, so a format drift on the transmitter shows up in the log as a readable
line instead of silent nothing.
"""

import struct

import config


def decode(payload: bytes):
    if payload is None or len(payload) < 21:
        return {"type": "unknown", "reason": "short payload",
                "length": 0 if payload is None else len(payload),
                "hex": payload.hex(" ") if payload else ""}

    raw = payload[:21]

    if raw[0] == config.CORRIDOR_TYPE:
        return _decode_corridor(raw)
    return _decode_telemetry(raw)


def _decode_telemetry(raw):
    try:
        (node_id, seq, lat_e7, lon_e7, speed_c, heading_c,
         route_bearing_c, altitude, flags, sats) = struct.unpack(
            config.PACKET_FMT, raw)
    except struct.error as exc:
        return {"type": "unknown", "reason": str(exc),
                "length": len(raw), "hex": raw.hex(" ")}

    return {
        "type": "telemetry",
        "node_id": node_id,
        "seq": seq,
        "lat": lat_e7 / 1e7,
        "lon": lon_e7 / 1e7,
        "speed_kmh": speed_c / 100.0,
        "heading": heading_c / 100.0,
        "route_bearing": route_bearing_c / 100.0,
        "altitude_m": altitude,
        "flags": flags,
        "sats": sats,
        "emergency": bool(flags & config.FLAG_EMERGENCY),
        "off_route": bool(flags & config.FLAG_OFF_ROUTE),
    }


def _decode_corridor(raw):
    try:
        fields = struct.unpack(config.CORRIDOR_FMT, raw)
    except struct.error as exc:
        return {"type": "unknown", "reason": str(exc),
                "length": len(raw), "hex": raw.hex(" ")}

    _t, version, index, total, n_points = fields[:5]
    coords = fields[5:]

    if not (0 < n_points <= config.CORRIDOR_POINTS_PER_CHUNK):
        return {"type": "unknown", "reason": "bad n_points=%d" % n_points,
                "length": len(raw), "hex": raw.hex(" ")}
    if total == 0 or index >= total:
        return {"type": "unknown",
                "reason": "bad chunk %d/%d" % (index, total),
                "length": len(raw), "hex": raw.hex(" ")}

    points = [(coords[i * 2] / 1e7, coords[i * 2 + 1] / 1e7)
              for i in range(n_points)]

    return {
        "type": "corridor",
        "version": version,
        "index": index,
        "total": total,
        "points": points,
    }