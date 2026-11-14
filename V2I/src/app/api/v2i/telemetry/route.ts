// POST /api/v2i/telemetry  - status from a roadside unit over Wi-Fi.
// Headers X-V2I-Timestamp / X-V2I-Sequence / X-V2I-Signature (HMAC-SHA256 of `${ts}.${seq}.${body}`).
// Order: size limit -> signature + clock drift (10 s) -> schema -> sequence strictly increasing
// per device (replay protection) -> store.
import { serverEnv } from "@/lib/server/env";
import { verifyTelemetry } from "@/lib/server/hmac";
import { json, readBody } from "@/lib/server/http";
import { Telemetry, issues } from "@/lib/server/schemas";
import { acceptSequence, putRsu, storeKind } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_SECRET_LEN = 32;

export async function POST(req: Request) {
  const secret = serverEnv.hmacSecret();
  if (!secret || secret.length < MIN_SECRET_LEN) return json({ error: `telemetry disabled: set V2I_HMAC_SECRET (${MIN_SECRET_LEN}+ characters) on the server` }, 503);
  const body = await readBody(req, 8192);
  if (body === null) return json({ error: "body too large" }, 413);
  const v = await verifyTelemetry(secret, req.headers, body);
  if (!v.ok) return json({ error: v.error }, v.status);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  const parsed = Telemetry.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid telemetry", issues: issues(parsed.error) }, 400);
  if (!(await acceptSequence(parsed.data.deviceId, v.sequence))) return json({ error: "sequence not higher than the last one from this device (replay?)" }, 409);
  await putRsu({ ...parsed.data, receivedAt: Date.now(), sequence: v.sequence });
  return json({ ok: true, store: storeKind() });
}
