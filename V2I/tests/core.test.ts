import { describe, expect, it } from "vitest";
import { Polyline, bearingDeg, classifyTurn, haversineM, wrap180 } from "@/lib/geo";
import { crc8, decodePacket, encodePacket, fromHex, toHex } from "@/lib/rf24PacketCodec";
import { OverpassElement, demoGrid, graphFromOverpass } from "@/lib/roadGraph";
import { SignalController, TIMING, V2IEngine } from "@/lib/v2iPreemptionEngine";
import { signTelemetry, verifyTelemetry } from "@/lib/server/hmac";

describe("geo", () => {
  it("haversine and bearings", () => {
    expect(haversineM([12.97, 77.59], [12.98, 77.59])).toBeCloseTo(1111.95, 0);
    expect(bearingDeg([12.97, 77.59], [12.98, 77.59])).toBeCloseTo(0, 3);
    expect(bearingDeg([12.97, 77.59], [12.97, 77.60])).toBeCloseTo(90, 1);
  });
  it("wrap180 and turn classification (compass bearings)", () => {
    expect(wrap180(270)).toBe(-90);
    expect(wrap180(-190)).toBe(170);
    expect(classifyTurn(0, 270).turn).toBe("LEFT"); // north, then west
    expect(classifyTurn(0, 90).turn).toBe("RIGHT"); // north, then east
    expect(classifyTurn(90, 100).turn).toBe("STRAIGHT");
    expect(classifyTurn(0, 180).turn).toBe("U_TURN");
    expect(classifyTurn(350, 260).dTheta).toBe(-90);
  });
  it("polyline arc length, projection, slice", () => {
    const p = new Polyline([[12.97, 77.59], [12.971, 77.59], [12.971, 77.591]]);
    expect(p.length).toBeCloseTo(111.2 + 108.4, 0);
    const pr = p.project([12.9705, 77.5901]);
    expect(pr.s).toBeCloseTo(55.6, 0);
    expect(pr.dist).toBeCloseTo(10.8, 0);
    expect(p.bearingAt(150)).toBeCloseTo(90, 0);
  });
});

describe("rf24 packet codec", () => {
  const sample = {
    ambulanceId: 101, lat: 12.9765634, lng: 77.6017948, headingDeg: 168.4, speedKmh: 56.2,
    nextWpLat: 12.9752185, nextWpLng: 77.607942, destLat: 12.9673251, destLng: 77.611243, turn: "LEFT" as const, severity: 3,
  };
  it("is exactly 32 bytes, magic first, CRC last", () => {
    const b = encodePacket(sample);
    expect(b.length).toBe(32);
    expect(b[0]).toBe(0xa5);
    expect(b[31]).toBe(crc8(b, 31));
    expect(b[30]).toBe(0x32); // turn 2 (left) | severity 3 << 4
  });
  it("round-trips", () => {
    const d = decodePacket(encodePacket(sample));
    expect(d.ok).toBe(true);
    expect(d.packet!.lat).toBeCloseTo(sample.lat, 7);
    expect(d.packet!.lng).toBeCloseTo(sample.lng, 7);
    expect(d.packet!.headingDeg).toBeCloseTo(168.4, 1);
    expect(d.packet!.speedKmh).toBeCloseTo(56.2, 1);
    expect(d.packet!.turn).toBe("LEFT");
    expect(d.packet!.severity).toBe(3);
  });
  it("rejects a corrupted frame", () => {
    const b = encodePacket(sample);
    b[5] ^= 0x10;
    const d = decodePacket(b);
    expect(d.ok).toBe(false);
    expect(d.errors.join()).toMatch(/CRC-8/);
    const m = encodePacket(sample);
    m[0] = 0x5a;
    m[31] = crc8(m, 31);
    expect(decodePacket(m).errors.join()).toMatch(/magic/);
  });
  it("CRC-8 (poly 0x07) check value", () => {
    expect(crc8(new TextEncoder().encode("123456789"))).toBe(0xf4);
  });
  it("hex helpers", () => {
    const b = encodePacket(sample);
    expect(fromHex(toHex(b))).toEqual(b);
    expect(fromHex("0xA5 0x65")).toEqual(new Uint8Array([0xa5, 0x65]));
  });
});

describe("road graph", () => {
  it("demo grid topology: T, 4-way, multi-arm", () => {
    const g = demoGrid();
    expect(g.topology("g2_2")).toBe("Multi-Arm Intersection");
    expect(g.topology("g1_1")).toBe("4-Way Crossroad");
    expect(g.topology("g0_2")).toBe("3-Way T-Junction");
    expect(g.topology("g0_0")).toBeNull();
  });
  it("routes along streets from pin to pin", () => {
    const g = demoGrid();
    const a = g.nodes.get("g0_0")!;
    const b = g.nodes.get("g3_2")!;
    const r = g.route([a.lat + 0.0003, a.lng + 0.00005], [b.lat, b.lng + 0.0004])!;
    expect(r).not.toBeNull();
    // every route point lies on a street (within 0.5 m of an edge)
    for (const p of r.pts) expect(g.snap(p)!.dist).toBeLessThan(0.5);
  });
  it("builds from Overpass JSON: splits ways at shared nodes, keeps one-way, finds signals", () => {
    const n = (id: number, lat: number, lon: number, tags?: Record<string, string>): OverpassElement => ({ type: "node", id, lat, lon, tags });
    const els: OverpassElement[] = [
      n(1, 12.970, 77.590), n(2, 12.971, 77.590), n(3, 12.972, 77.590, { highway: "traffic_signals" }), n(4, 12.973, 77.590),
      n(5, 12.972, 77.589), n(6, 12.972, 77.591), n(7, 12.972, 77.592),
      n(90, 12.990, 77.600), n(91, 12.991, 77.600), // separate island: dropped
      { type: "way", id: 100, nodes: [1, 2, 3, 4], tags: { highway: "primary", name: "Main Road" } },
      { type: "way", id: 101, nodes: [5, 3, 6, 7], tags: { highway: "residential", name: "Side Street", oneway: "yes" } },
      { type: "way", id: 102, nodes: [90, 91], tags: { highway: "residential" } },
      { type: "way", id: 103, nodes: [1, 5], tags: { highway: "footway" } },
    ];
    const g = graphFromOverpass(els);
    expect(g.nodes.has("n90")).toBe(false);
    expect(g.topology("n3")).toBe("4-Way Crossroad");
    expect(g.nodes.get("n3")!.signal).toBe(true);
    // node 6 is used by one way only, so it is shape, not a vertex: the side street is n5 - n3 - n7
    expect(g.nodes.has("n6")).toBe(false);
    // one-way eastbound: from n3 you can go east (to n7) but not west (to n5)
    const moves = g.out.get("n3")!.map((m) => m.to);
    expect(moves).toContain("n7");
    expect(moves).not.toContain("n5");
    // so a route from the east end back to the west end of the side street does not exist
    expect(g.route([12.9720, 77.5915], [12.9720, 77.5893])).toBeNull();
    // but west to east does, along the street
    expect(g.route([12.9720, 77.5893], [12.9720, 77.5915])).not.toBeNull();
  });
});

describe("signal controller", () => {
  it("normal cycle: green 12, yellow 3, all-red 2 per arm, one green at a time", () => {
    const c = new SignalController(4);
    const seen: string[] = [];
    for (let t = 0; t < 4 * 17; t += 0.1) {
      c.step(0.1, null);
      const lamps = [0, 1, 2, 3].map((i) => c.lamp(i)).join("");
      if (seen[seen.length - 1] !== lamps) seen.push(lamps);
      expect(lamps.split("").filter((x) => x === "G").length).toBeLessThanOrEqual(1);
    }
    expect(seen.slice(0, 6)).toEqual(["GRRR", "YRRR", "RRRR", "RGRR", "RYRR", "RRRR"]);
  });
  it("pre-emption: honours min green, then clears via yellow and all-red to the requested arm", () => {
    const c = new SignalController(4);
    c.step(1, null); // arm 0 green for 1 s
    let t = 1;
    while (c.lamp(2) !== "G") { c.step(0.05, 2); t += 0.05; }
    expect(t).toBeCloseTo(TIMING.MIN_GREEN_S + TIMING.YELLOW_S + TIMING.ALL_RED_S, 0);
    for (let k = 0; k < 400; k++) c.step(0.05, 2); // held while requested
    expect(c.lamp(2)).toBe("G");
    c.step(0.05, null); // ambulance passed: ends at once via yellow
    expect(c.lamp(2)).toBe("Y");
  });
});

describe("engine", () => {
  it("snaps a dropped pin to the nearest junction and assigns GPIOs per arm", () => {
    const e = new V2IEngine(demoGrid());
    const n = e.graph.nodes.get("g2_2")!;
    const r = e.addJunctionAt([n.lat + 0.0002, n.lng]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.junction.topology).toBe("Multi-Arm Intersection");
    expect(r.junction.arms.length).toBe(5);
    const pins = r.junction.arms.flatMap((a) => a.gpio);
    expect(new Set(pins).size).toBe(15);
    expect(e.addJunctionAt([0, 0]).ok).toBe(false);
  });
  it("TX packet carries the next junction on the route and the turn", () => {
    const e = new V2IEngine(demoGrid());
    for (const id of ["g1_2", "g2_2", "g3_2"]) { const n = e.graph.nodes.get(id)!; e.addJunctionAt([n.lat, n.lng]); }
    const a = e.graph.nodes.get("g0_2")!;
    const b = e.graph.nodes.get("g4_2")!;
    const d = e.dispatch({ start: [a.lat, a.lng], dest: [b.lat, b.lng], speedKmh: 40, severity: 2 });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const { packet, bytes } = e.txPacket(d.ambulance);
    const j1 = e.junctions.get("J01")!;
    expect(packet.nextWpLat).toBeCloseTo(j1.lat, 6);
    expect(packet.turn).toBe("STRAIGHT");
    expect(decodePacket(bytes).ok).toBe(true);
  });
});

describe("telemetry HMAC", () => {
  it("accepts a good signature and rejects tampering, replays from the past and clock drift", async () => {
    const secret = "test-secret-0123456789abcdef0123456789";
    const body = JSON.stringify({ deviceId: "RSU-J01" });
    const now = 1_790_000_000;
    const sig = await signTelemetry(secret, now, 42, body);
    const h = (ts: number, seq: number, s: string) => new Headers({ "x-v2i-timestamp": String(ts), "x-v2i-sequence": String(seq), "x-v2i-signature": s });
    expect((await verifyTelemetry(secret, h(now, 42, sig), body, now)).ok).toBe(true);
    expect((await verifyTelemetry(secret, h(now, 43, sig), body, now)).ok).toBe(false);
    expect((await verifyTelemetry(secret, h(now, 42, sig), body + " ", now)).ok).toBe(false);
    const drift = await verifyTelemetry(secret, h(now, 42, sig), body, now + 11);
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.error).toMatch(/drift/);
  });
  it("matches an independent HMAC-SHA256 (RFC 4231 test case 2)", async () => {
    // key "Jefe", data "what do ya want for nothing?" -> split as `${ts}.${seq}.${body}` is not possible,
    // so check the primitive through a timestamp/sequence-free call:
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("Jefe"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("what do ya want for nothing?")));
    expect(Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
});
