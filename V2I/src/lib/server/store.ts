// Telemetry state: Upstash Redis when configured (shared by every Vercel instance), otherwise
// process memory (one instance only: fine for `next start` on a laptop, not for Vercel).
import "server-only";
import { Redis } from "@upstash/redis";
import { hasUpstash, serverEnv } from "./env";
import type { TelemetryBody } from "./schemas";

export interface RsuRecord extends TelemetryBody {
  receivedAt: number; // ms
  sequence: number;
}

const TTL_S = 60; // a unit that stopped reporting disappears after a minute

let redis: Redis | null = null;
const getRedis = () => (redis ??= new Redis({ url: serverEnv.upstashUrl()!, token: serverEnv.upstashToken()!, enableTelemetry: false }));

const mem = { seq: new Map<string, number>(), rsu: new Map<string, RsuRecord>(), ver: 0 };

// Atomic "sequence must be higher than the last one" (anti-replay), in one Redis round trip.
const SEQ_LUA = `local last = tonumber(redis.call('GET', KEYS[1]) or '-1')
if tonumber(ARGV[1]) <= last then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1`;

export const storeKind = () => (hasUpstash() ? "upstash" : "memory");

/** true if `sequence` is newer than anything seen from this device (and records it). */
export async function acceptSequence(deviceId: string, sequence: number): Promise<boolean> {
  if (hasUpstash()) {
    const r = await getRedis().eval(SEQ_LUA, [`v2i:seq:${deviceId}`], [String(sequence)]);
    return Number(r) === 1;
  }
  const last = mem.seq.get(deviceId) ?? -1;
  if (sequence <= last) return false;
  mem.seq.set(deviceId, sequence);
  return true;
}

export async function putRsu(rec: RsuRecord): Promise<void> {
  if (hasUpstash()) {
    const r = getRedis();
    await r.set(`v2i:rsu:${rec.deviceId}`, JSON.stringify(rec), { ex: TTL_S });
    await r.sadd("v2i:rsu-ids", rec.deviceId);
    await r.incr("v2i:ver");
    return;
  }
  mem.rsu.set(rec.deviceId, rec);
  mem.ver++;
}

/** Changes whenever a unit reports; the SSE stream polls this (1 cheap command) and lists only on change. */
export async function version(): Promise<number> {
  if (hasUpstash()) return Number((await getRedis().get<number>("v2i:ver")) ?? 0);
  return mem.ver;
}

export async function listRsu(): Promise<RsuRecord[]> {
  const now = Date.now();
  if (hasUpstash()) {
    const r = getRedis();
    const ids = (await r.smembers("v2i:rsu-ids")) as string[];
    if (!ids.length) return [];
    const vals = await r.mget<(RsuRecord | string | null)[]>(...ids.map((id) => `v2i:rsu:${id}`));
    const out: RsuRecord[] = [];
    const gone: string[] = [];
    vals.forEach((v, i) => {
      if (v == null) gone.push(ids[i]);
      else out.push(typeof v === "string" ? (JSON.parse(v) as RsuRecord) : v);
    });
    if (gone.length) await r.srem("v2i:rsu-ids", ...gone);
    return out;
  }
  for (const [k, v] of mem.rsu) if (now - v.receivedAt > TTL_S * 1000) mem.rsu.delete(k);
  return [...mem.rsu.values()];
}
