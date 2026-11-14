// Compiles tests/firmware_host_test.cpp (the roadside unit's real logic) with g++ and runs it.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "v2i-fw-")), process.platform === "win32" ? "rsu_test.exe" : "rsu_test");
try {
  execFileSync("g++", ["-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror", "-o", out, "tests/firmware_host_test.cpp"], { stdio: "inherit" });
} catch {
  console.error("g++ not found or compile failed. Install g++ (MinGW on Windows) to run the firmware host test.");
  process.exit(1);
}
execFileSync(out, { stdio: "inherit" });
