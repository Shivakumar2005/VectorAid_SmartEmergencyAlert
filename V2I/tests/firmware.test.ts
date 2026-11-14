import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodePacket, toHex } from "@/lib/rf24PacketCodec";
import { GPIO_POOL, TIMING, DETECT_M } from "@/lib/v2iPreemptionEngine";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("firmware parity", () => {
  it("both sketches carry an identical copy of v2i_protocol.h (run scripts/sync-firmware-headers.mjs)", () => {
    const canonical = read("firmware/include/v2i_protocol.h");
    expect(read("firmware/ambulance_tx_esp32s3/v2i_protocol.h")).toBe(canonical);
    expect(read("firmware/roadside_rx_esp32s3/v2i_protocol.h")).toBe(canonical);
  });

  it("TypeScript encodes the same bytes as the C++ host test's golden packet", () => {
    const golden = /GOLDEN_HEX = "([0-9A-F]{64})"/.exec(read("tests/firmware_host_test.cpp"))![1];
    const sample = {
      ambulanceId: 101, lat: 12.9765634, lng: 77.6017948, headingDeg: 168.4, speedKmh: 56.2,
      nextWpLat: 12.9752185, nextWpLng: 77.607942, destLat: 12.9673251, destLng: 77.611243, turn: "LEFT" as const, severity: 3,
    };
    expect(toHex(encodePacket(sample), "")).toBe(golden);
  });

  it("RSU constants match the simulation (timing, 200 m, GPIO pool)", () => {
    const h = read("firmware/roadside_rx_esp32s3/v2i_rsu_logic.h");
    const num = (name: string) => Number(new RegExp(`${name} = ([0-9.]+)f?`).exec(h)![1]);
    expect(num("GREEN_S")).toBe(TIMING.GREEN_S);
    expect(num("YELLOW_S")).toBe(TIMING.YELLOW_S);
    expect(num("ALL_RED_S")).toBe(TIMING.ALL_RED_S);
    expect(num("MIN_GREEN_S")).toBe(TIMING.MIN_GREEN_S);
    expect(num("MAX_HOLD_S")).toBe(TIMING.MAX_HOLD_S);
    expect(num("LOCKOUT_S")).toBe(TIMING.LOCKOUT_S);
    expect(num("DETECT_M")).toBe(DETECT_M);
    const pool = /GPIO_POOL\[16\] = \{([^}]+)\}/.exec(h)![1].split(",").map((x) => Number(x.trim()));
    expect(pool).toEqual(GPIO_POOL);
  });
});
