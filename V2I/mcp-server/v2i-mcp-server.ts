#!/usr/bin/env node
// MCP server "v2i-traffic-controller" (stdio). Gives Claude (or any MCP client) the same engine the
// web app runs: dispatch ambulances, drop traffic-light pins, read signal heads and GPIO levels,
// encode/decode the 32-byte radio packet, and run the S1-S7 verification scenarios.
//
// It runs locally, on the synthetic demo grid (no network access, no keys).
//   npm run mcp            or            npx tsx mcp-server/v2i-mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Polyline, type LL } from "../src/lib/geo";
import { decodePacket, encodePacket, FIELD_MAP, fromHex, toHex, type V2IPacket } from "../src/lib/rf24PacketCodec";
import { demoGrid, DEMO_ORIGIN } from "../src/lib/roadGraph";
import { runScenarioVerification, SCENARIOS } from "../src/lib/scenarios";
import { V2IEngine } from "../src/lib/v2iPreemptionEngine";

let engine = new V2IEngine(demoGrid());
const STEP_S = 0.05;

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

function advance(seconds: number) {
  const n = Math.round(Math.min(600, Math.max(0, seconds)) / STEP_S);
  for (let i = 0; i < n; i++) engine.step(STEP_S);
}

const nodeList = () => [...engine.graph.nodes.values()].map((n) => `${n.id} (${n.lat.toFixed(5)}, ${n.lng.toFixed(5)}, ${engine.graph.topology(n.id) ?? "bend/end"})`).join("; ");

function point(nodeId: string | undefined, lat: number | undefined, lng: number | undefined, what: string): LL | string {
  if (nodeId) {
    const n = engine.graph.nodes.get(nodeId);
    return n ? [n.lat, n.lng] : `${what}: no node "${nodeId}". Nodes: ${nodeList()}`;
  }
  if (lat !== undefined && lng !== undefined) return [lat, lng];
  return `${what}: give a node id (e.g. g0_2) or lat and lng`;
}

const server = new McpServer({ name: "v2i-traffic-controller", version: "1.0.0" });

server.registerTool(
  "v2i_dispatch_ambulance",
  {
    title: "Dispatch an ambulance",
    description:
      `Routes an ambulance along the demo street grid (origin ${DEMO_ORIGIN.join(", ")}, 6 x 5 blocks of 180 m; node ids g<col>_<row>, ` +
      "e.g. g0_2 to g5_2) from a start to a hospital. Roadside units are placed at every junction on the route unless placeRoadsideUnits is false. " +
      "Returns the route, each junction on it with the turn (STRAIGHT/LEFT/RIGHT from delta-theta = wrap180(out - in)) and the radio packet it transmits now. " +
      "Optionally simulates seconds afterwards and reports what each junction did.",
    inputSchema: {
      fromNode: z.string().optional().describe("start node id, e.g. g0_2"),
      toNode: z.string().optional().describe("hospital node id, e.g. g5_2"),
      startLat: z.number().min(-90).max(90).optional(),
      startLng: z.number().min(-180).max(180).optional(),
      destLat: z.number().min(-90).max(90).optional(),
      destLng: z.number().min(-180).max(180).optional(),
      speedKmh: z.number().min(5).max(120).default(45),
      severity: z.number().int().min(1).max(3).default(2),
      number: z.number().int().min(1).max(255).optional().describe("ambulance number: 101 makes AMB-101"),
      placeRoadsideUnits: z.boolean().default(true),
      simulateSeconds: z.number().min(0).max(600).default(0),
    },
  },
  async (a) => {
    const start = point(a.fromNode, a.startLat, a.startLng, "start");
    const dest = point(a.toNode, a.destLat, a.destLng, "destination");
    if (typeof start === "string") return fail(start);
    if (typeof dest === "string") return fail(dest);
    const r = engine.graph.route(start, dest);
    if (!r) return fail("no route between those points on the demo grid");
    if (a.placeRoadsideUnits) {
      const line = new Polyline(r.pts);
      for (const nd of engine.graph.nodes.values()) {
        const d = engine.graph.degree(nd.id);
        if (d < 3 || d > 5 || [...engine.junctions.values()].some((j) => j.nodeId === nd.id)) continue;
        const pr = line.project([nd.lat, nd.lng]);
        if (pr.dist <= 12 && pr.s > 5 && pr.s < line.length - 5) engine.addJunctionAt([nd.lat, nd.lng]);
      }
    }
    const d = engine.dispatch({ routePts: r.pts, speedKmh: a.speedKmh, severity: a.severity, num: a.number });
    if (!d.ok) return fail(d.error);
    const amb = d.ambulance;
    const { bytes } = engine.txPacket(amb);
    const before = engine.events.length;
    advance(a.simulateSeconds);
    return text({
      ambulance: engine.ambulanceState(amb),
      txPacketHex: toHex(bytes, ""),
      simulatedSeconds: a.simulateSeconds,
      events: engine.events.slice(before).map((e) => `${e.t}s ${e.msg}`),
      kpi: engine.kpi,
    });
  },
);

server.registerTool(
  "v2i_drop_traffic_light_pin",
  {
    title: "Drop a traffic-light pin",
    description:
      "Places a roadside unit at the junction nearest to a point (within 80 m). Classifies it (3-Way T-Junction, 3-Way Y-Junction, 4-Way Crossroad, " +
      "Multi-Arm Intersection) and assigns R/Y/G GPIOs per arm on the ESP32-S3 (max 5 arms). Give lat/lng or a node id.",
    inputSchema: {
      node: z.string().optional().describe("node id, e.g. g2_2 (the five-arm junction)"),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
    },
  },
  async (a) => {
    const p = point(a.node, a.lat, a.lng, "pin");
    if (typeof p === "string") return fail(p);
    const r = engine.addJunctionAt(p);
    if (!r.ok) return fail(r.error);
    return text(engine.junctionState(r.junction));
  },
);

server.registerTool(
  "v2i_inspect_junction_signals",
  {
    title: "Inspect junction signals",
    description:
      "Returns each roadside unit's signal heads: per arm the lamp (R/Y/G), the GPIO levels, queued cars, the controller mode (NORMAL/PREEMPT/RECOVER), " +
      "phase and countdown, the ambulance being served and those waiting. Optionally advances the simulation first.",
    inputSchema: {
      junctionId: z.string().optional().describe("e.g. J01; omit for all"),
      advanceSeconds: z.number().min(0).max(600).default(0),
    },
  },
  async (a) => {
    advance(a.advanceSeconds);
    const list = [...engine.junctions.values()].filter((j) => !a.junctionId || j.id === a.junctionId);
    if (a.junctionId && !list.length) return fail(`no junction ${a.junctionId}; placed: ${[...engine.junctions.keys()].join(", ") || "none"}`);
    return text({
      t: engine.t,
      junctions: list.map((j) => {
        const s = engine.junctionState(j);
        return { ...s, arms: s.arms.map((arm) => ({ ...arm, gpioLevels: { [arm.gpio.red]: arm.lamp === "R" ? "HIGH" : "LOW", [arm.gpio.yellow]: arm.lamp === "Y" ? "HIGH" : "LOW", [arm.gpio.green]: arm.lamp === "G" ? "HIGH" : "LOW" } })) };
      }),
      ambulances: [...engine.ambulances.values()].map((x) => engine.ambulanceState(x)),
    });
  },
);

server.registerTool(
  "v2i_encode_decode_rf24_packet",
  {
    title: "Encode or decode the 32-byte radio packet",
    description:
      "Decodes a 32-byte V2IPacket_t from hex (checks magic 0xA5, CRC-8 poly 0x07, ranges), or encodes one from fields. " +
      "Layout (little-endian): magic, ambulance_id, lat_e7, lon_e7, heading_decideg, speed_decikmh, next_wp lat/lon_e7, dest lat/lon_e7, turn|severity<<4, crc8.",
    inputSchema: {
      hex: z.string().optional().describe("64 hex digits (spaces and 0x allowed) to decode"),
      fields: z
        .object({
          ambulanceId: z.number().int().min(0).max(255),
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          headingDeg: z.number().min(0).max(360),
          speedKmh: z.number().min(0).max(200),
          nextWpLat: z.number().min(-90).max(90).default(0),
          nextWpLng: z.number().min(-180).max(180).default(0),
          destLat: z.number().min(-90).max(90).default(0),
          destLng: z.number().min(-180).max(180).default(0),
          turn: z.enum(["NONE", "STRAIGHT", "LEFT", "RIGHT", "U_TURN"]).default("NONE"),
          severity: z.number().int().min(0).max(15).default(2),
        })
        .optional()
        .describe("fields to encode"),
    },
  },
  async (a) => {
    if (a.hex) {
      let bytes: Uint8Array;
      try {
        bytes = fromHex(a.hex);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      const d = decodePacket(bytes);
      return text({ ok: d.ok, errors: d.errors, packet: d.packet, crcExpected: `0x${d.crcExpected.toString(16)}`, crcReceived: `0x${d.crcReceived.toString(16)}`, fieldMap: FIELD_MAP });
    }
    if (a.fields) {
      const bytes = encodePacket(a.fields as V2IPacket);
      return text({ hex: toHex(bytes, ""), spaced: toHex(bytes), bytes: bytes.length, decodedBack: decodePacket(bytes).packet });
    }
    return fail("give either hex (to decode) or fields (to encode)");
  },
);

server.registerTool(
  "v2i_run_scenario_verification",
  {
    title: "Run scenario verification",
    description:
      "Runs a scenario headless on a fresh demo grid and checks the rules: one green at a time, yellow + all-red between greens, " +
      "no off-route triggers, green on arrival, turn/topology, multi-ambulance order. " +
      SCENARIOS.map((s) => `${s.id} = ${s.name}`).join("; ") + ". Use 0 for all seven.",
    inputSchema: { scenario: z.number().int().min(0).max(7).default(0) },
  },
  async (a) => {
    const ids = a.scenario === 0 ? [1, 2, 3, 4, 5, 6, 7] : [a.scenario];
    const results = ids.map((id) => {
      const r = runScenarioVerification(id, demoGrid());
      return { id: r.id, name: r.name, passed: r.passed, simulatedS: r.simulatedS, checks: r.checks, servedOrder: r.servedOrder, kpi: r.kpi };
    });
    return text({ allPassed: results.every((r) => r.passed), results });
  },
);

server.registerTool(
  "v2i_reset_simulation",
  {
    title: "Reset the simulation",
    description: "Clears all ambulances and roadside units and restarts the demo grid at t = 0.",
    inputSchema: {},
  },
  async () => {
    engine = new V2IEngine(demoGrid());
    return text("reset: demo grid, no roadside units, no ambulances");
  },
);

server.connect(new StdioServerTransport()).catch((e) => {
  console.error("v2i-mcp-server failed to start:", e);
  process.exit(1);
});
