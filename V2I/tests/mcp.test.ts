// Starts the MCP server exactly as a client would (stdio) and calls every tool.
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const t = r.content[0].text;
  let json: unknown = null;
  try { json = JSON.parse(t); } catch { /* plain text */ }
  return { isError: !!r.isError, text: t, json: json as Record<string, unknown> };
};

beforeAll(async () => {
  client = new Client({ name: "v2i-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "mcp-server/v2i-mcp-server.ts")], cwd: root, stderr: "pipe" }));
}, 60_000);
afterAll(async () => { await client?.close(); });

describe("MCP server v2i-traffic-controller", () => {
  it("lists the tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["v2i_dispatch_ambulance", "v2i_drop_traffic_light_pin", "v2i_encode_decode_rf24_packet", "v2i_inspect_junction_signals", "v2i_reset_simulation", "v2i_run_scenario_verification"]);
  });

  it("drops a pin on the five-arm junction", async () => {
    const r = await call("v2i_drop_traffic_light_pin", { node: "g2_2" });
    expect(r.isError).toBe(false);
    expect(r.json.topology).toBe("Multi-Arm Intersection");
    expect((r.json.arms as unknown[]).length).toBe(5);
    expect((await call("v2i_drop_traffic_light_pin", { lat: 0, lng: 0 })).isError).toBe(true);
  });

  it("dispatches an ambulance, which pre-empts the junctions on its route", async () => {
    const r = await call("v2i_dispatch_ambulance", { fromNode: "g0_2", toNode: "g5_2", speedKmh: 40, simulateSeconds: 90 });
    expect(r.isError).toBe(false);
    const amb = r.json.ambulance as { id: string; arrived: boolean; junctions: { turn: string; greenOnArrival: boolean | null }[] };
    expect(amb.id).toBe("AMB-101");
    expect(amb.arrived).toBe(true);
    expect(amb.junctions.length).toBeGreaterThanOrEqual(4);
    expect(amb.junctions.every((j) => j.turn === "STRAIGHT")).toBe(true);
    expect((r.json.events as string[]).some((e) => e.includes("PREEMPT"))).toBe(true);
    expect((r.json.kpi as { conflicts: number }).conflicts).toBe(0);
    expect(r.json.txPacketHex).toMatch(/^A5[0-9A-F]{62}$/);
  });

  it("inspects signal heads with GPIO levels", async () => {
    const r = await call("v2i_inspect_junction_signals", { advanceSeconds: 1 });
    const js = r.json.junctions as { arms: { lamp: string; gpioLevels: Record<string, string> }[] }[];
    expect(js.length).toBeGreaterThan(0);
    for (const j of js) {
      expect(j.arms.filter((a) => a.lamp === "G").length).toBeLessThanOrEqual(1);
      for (const a of j.arms) expect(Object.values(a.gpioLevels).filter((v) => v === "HIGH").length).toBe(1);
    }
  });

  it("encodes and decodes the 32-byte packet, and rejects a bad CRC", async () => {
    const enc = await call("v2i_encode_decode_rf24_packet", { fields: { ambulanceId: 101, lat: 12.9765634, lng: 77.6017948, headingDeg: 168.4, speedKmh: 56.2, nextWpLat: 12.9752185, nextWpLng: 77.607942, destLat: 12.9673251, destLng: 77.611243, turn: "LEFT", severity: 3 } });
    expect(enc.json.hex).toBe("A5650211BC071C18412E9406320279DCBB073C08422E23A8BA072E89422E32D6");
    const dec = await call("v2i_encode_decode_rf24_packet", { hex: enc.json.hex as string });
    expect(dec.json.ok).toBe(true);
    const bad = await call("v2i_encode_decode_rf24_packet", { hex: (enc.json.hex as string).replace(/D6$/, "D7") });
    expect(bad.json.ok).toBe(false);
  });

  it("runs the S1-S7 verification", async () => {
    const r = await call("v2i_run_scenario_verification", { scenario: 0 });
    const results = r.json.results as { name: string; passed: boolean }[];
    expect(results.length).toBe(7);
    expect(results.filter((x) => !x.passed).map((x) => x.name)).toEqual([]);
  }, 120_000);
});
