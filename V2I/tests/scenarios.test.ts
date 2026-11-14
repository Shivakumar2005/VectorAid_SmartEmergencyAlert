import { describe, expect, it } from "vitest";
import { SCENARIOS, runScenarioVerification } from "@/lib/scenarios";

describe("scenario verification S1-S7 (demo grid)", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      const r = runScenarioVerification(sc.id);
      const report = r.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name} - ${c.detail}`).join("\n");
      if (!r.passed) console.log(`${r.name}\n${report}\n${r.events.join("\n")}`);
      expect(r.passed, report).toBe(true);
    });
  }
});
