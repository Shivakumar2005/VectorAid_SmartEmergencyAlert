// HMAC-SHA256 for roadside-unit telemetry, with Web Crypto (works on Node and on the Edge).
//
//   message   = `${timestamp}.${sequence}.${rawBody}`
//   signature = lowercase hex HMAC-SHA256(V2I_HMAC_SECRET, message)
//   headers   X-V2I-Timestamp: unix seconds   X-V2I-Sequence: per-device counter   X-V2I-Signature: hex
//
// The firmware (roadside_rx_esp32s3.ino) builds exactly the same string with mbedTLS.

const enc = new TextEncoder();

export const MAX_DRIFT_S = 10;

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export async function signTelemetry(secret: string, timestamp: number | string, sequence: number | string, body: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(`${timestamp}.${sequence}.${body}`));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type VerifyResult = { ok: true; timestamp: number; sequence: number } | { ok: false; status: number; error: string };

/** Checks the headers, the clock drift and the signature (constant-time, via crypto.subtle.verify). */
export async function verifyTelemetry(secret: string, headers: Headers, body: string, nowS = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  const ts = headers.get("x-v2i-timestamp") ?? "";
  const seq = headers.get("x-v2i-sequence") ?? "";
  const sig = headers.get("x-v2i-signature") ?? "";
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, status: 401, error: "missing or malformed X-V2I-Timestamp" };
  if (!/^\d{1,15}$/.test(seq)) return { ok: false, status: 401, error: "missing or malformed X-V2I-Sequence" };
  const bytes = hexToBytes(sig);
  if (!bytes) return { ok: false, status: 401, error: "missing or malformed X-V2I-Signature" };
  const timestamp = Number(ts);
  if (Math.abs(nowS - timestamp) > MAX_DRIFT_S) return { ok: false, status: 401, error: `timestamp drift ${nowS - timestamp} s exceeds ${MAX_DRIFT_S} s` };
  const good = await crypto.subtle.verify("HMAC", await key(secret), bytes, enc.encode(`${ts}.${seq}.${body}`));
  if (!good) return { ok: false, status: 401, error: "bad signature" };
  return { ok: true, timestamp, sequence: Number(seq) };
}
