// Arduino compiles only the files inside a sketch's own folder, so each sketch carries a copy of
// firmware/include/v2i_protocol.h. Run this after editing that file: node scripts/sync-firmware-headers.mjs
// (tests/firmware.test.ts fails if a copy differs).
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "firmware/include/v2i_protocol.h");
for (const sketch of ["ambulance_tx_esp32s3", "roadside_rx_esp32s3"]) {
  const dst = join(root, "firmware", sketch, "v2i_protocol.h");
  copyFileSync(src, dst);
  if (readFileSync(dst, "utf8") !== readFileSync(src, "utf8")) throw new Error(`copy to ${dst} failed`);
  console.log(`synced ${dst.slice(root.length + 1)}`);
}
