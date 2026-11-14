// GET /api/v2i/config  - which server features are switched on. Booleans only, never values.
import { serverEnv } from "@/lib/server/env";
import { json } from "@/lib/server/http";
import { storeKind } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const secret = serverEnv.hmacSecret();
  return json({
    ors: Boolean(serverEnv.orsKey()),
    telemetry: Boolean(secret && secret.length >= 32),
    store: storeKind(),
    tileProxy: Boolean(serverEnv.tileContact()),
  });
}
