"""Wire format for the V2V link.

Two packet types, both exactly 21 bytes, discriminated by byte 0:
  byte0 == 1     -> telemetry   (node_id; see config.PACKET_FMT)
  byte0 == 0xC0  -> corridor chunk (see config.CORRIDOR_FMT)

Copy this file unchanged to the receiver so both sides agree.
"""

import struct

import config

CORRIDOR_TYPE = config.CORRIDOR_TYPE
POINTS_PER_CHUNK = 2

TELEMETRY_SIZE = struct.calcsize(config.PACKET_FMT)
CORRIDOR_SIZE = struct.calcsize(config.CORRIDOR_FMT)

assert TELEMETRY_SIZE == 21, TELEMETRY_SIZE
assert CORRIDOR_SIZE == 21, CORRIDOR_SIZE


def packet_type(raw):
    """Returns byte 0. Compare against CORRIDOR_TYPE or the node_id."""
    return raw[0] if raw else None


# ---------------- telemetry ----------------

def pack_telemetry(node_id, seq, lat, lon, speed_kmh, heading,
                   route_bearing, alt_m, flags, sats):
    return struct.pack(
        config.PACKET_FMT,
        node_id,
        seq & 0xFFFF,
        int(round(lat * 1e7)),
        int(round(lon * 1e7)),
        int(min(max(speed_kmh, 0.0), 655.0) * 100),
        int((heading % 360.0) * 100),
        int((route_bearing % 360.0) * 100),
        int(alt_m),
        flags,
        min(sats, 255),
    )


def unpack_telemetry(raw):
    f = struct.unpack(config.PACKET_FMT, bytes(raw[:TELEMETRY_SIZE]))
    return {
        "node_id": f[0], "seq": f[1],
        "lat": f[2] / 1e7, "lon": f[3] / 1e7,
        "speed": f[4] / 100.0, "heading": f[5] / 100.0,
        "route_bearing": f[6] / 100.0, "alt": f[7],
        "flags": f[8], "sats": f[9],
    }


# ---------------- corridor ----------------

def downsample(points, max_points):
    """Uniform index sampling that always keeps the first and last point."""
    n = len(points)
    if n <= max_points:
        return list(points)
    if max_points < 2:
        return [points[0]]
    step = (n - 1) / (max_points - 1)
    idx = sorted({min(int(round(i * step)), n - 1) for i in range(max_points)})
    return [points[i] for i in idx]


def pack_corridor_chunk(version, chunk_index, chunk_total, pts):
    n = len(pts)
    if not 1 <= n <= POINTS_PER_CHUNK:
        raise ValueError(f"chunk must hold 1..{POINTS_PER_CHUNK} points, got {n}")

    coords = []
    for i in range(POINTS_PER_CHUNK):
        if i < n:
            lat, lon = pts[i]
            coords += [int(round(lat * 1e7)), int(round(lon * 1e7))]
        else:
            coords += [0, 0]

    return struct.pack(
        config.CORRIDOR_FMT,
        CORRIDOR_TYPE,
        version & 0xFF,
        chunk_index & 0xFF,
        chunk_total & 0xFF,
        n,
        *coords,
    )


def unpack_corridor_chunk(raw):
    if len(raw) < CORRIDOR_SIZE:
        raise ValueError("short corridor packet")
    f = struct.unpack(config.CORRIDOR_FMT, bytes(raw[:CORRIDOR_SIZE]))
    if f[0] != CORRIDOR_TYPE:
        raise ValueError(f"not a corridor packet (byte0=0x{f[0]:02x})")

    version, ci, ct, n = f[1], f[2], f[3], f[4]
    coords = f[5:]
    pts = [(coords[i * 2] / 1e7, coords[i * 2 + 1] / 1e7)
           for i in range(min(n, POINTS_PER_CHUNK))]
    return {"version": version, "chunk_index": ci,
            "chunk_total": ct, "points": pts}


def build_corridor_chunks(points, version):
    """Downsample to CORRIDOR_MAX_POINTS and split into 21-byte chunks."""
    pts = downsample(points, config.CORRIDOR_MAX_POINTS)
    if len(pts) < 2:
        return []
    groups = [pts[i:i + POINTS_PER_CHUNK]
              for i in range(0, len(pts), POINTS_PER_CHUNK)]
    total = len(groups)
    return [pack_corridor_chunk(version, i, total, g)
            for i, g in enumerate(groups)]


class CorridorAssembler:
    """Receiver-side reassembly. Keeps only the newest version seen."""

    def __init__(self, stale_after=4.0):
        self.stale_after = stale_after
        self.version = None
        self.total = 0
        self.parts = {}
        self.complete = []
        self.last_update = 0.0

    def feed(self, raw, now):
        try:
            c = unpack_corridor_chunk(raw)
        except ValueError:
            return False

        if c["version"] != self.version:
            self.version = c["version"]
            self.total = c["chunk_total"]
            self.parts = {}

        self.parts[c["chunk_index"]] = c["points"]
        self.last_update = now

        if self.total and len(self.parts) == self.total:
            pts = []
            for i in range(self.total):
                pts.extend(self.parts[i])
            self.complete = pts
            return True
        return False

    def get(self, now):
        if not self.complete or now - self.last_update > self.stale_after:
            return []
        return self.complete
