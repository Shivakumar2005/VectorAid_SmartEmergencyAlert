// Rate limiting used by src/middleware.ts. Upstash sliding window when configured (holds across
// all Vercel instances); otherwise a fixed window in this instance's memory.
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis/cloudflare"; // fetch-only build: runs in Edge middleware

export interface Rule { name: string; limit: number; windowS: number }

/** Per client IP. Order matters: first match wins. */
export const RULES: [RegExp, Rule][] = [
  [/^\/api\/v2i\/route/, { name: "route", limit: 30, windowS: 60 }],
  [/^\/api\/v2i\/roads/, { name: "roads", limit: 10, windowS: 60 }],
  [/^\/api\/v2i\/telemetry/, { name: "telemetry", limit: 120, windowS: 60 }],
  [/^\/api\/v2i\/stream/, { name: "stream", limit: 20, windowS: 60 }],
  [/^\/api\/tiles\//, { name: "tiles", limit: 600, windowS: 60 }],
  [/^\/api\//, { name: "api", limit: 120, windowS: 60 }],
];

export const ruleFor = (path: string): Rule | null => RULES.find(([re]) => re.test(path))?.[1] ?? null;

export interface LimitResult { success: boolean; limit: number; remaining: number; reset: number }

const upstash = new Map<string, Ratelimit>();
const windows = new Map<string, { start: number; count: number }>();

export async function checkLimit(rule: Rule, ip: string, env: { url?: string; token?: string }): Promise<LimitResult> {
  if (env.url && env.token) {
    let rl = upstash.get(rule.name);
    if (!rl) {
      rl = new Ratelimit({
        redis: new Redis({ url: env.url, token: env.token, enableTelemetry: false }),
        limiter: Ratelimit.slidingWindow(rule.limit, `${rule.windowS} s`),
        prefix: `v2i:rl:${rule.name}`,
      });
      upstash.set(rule.name, rl);
    }
    const r = await rl.limit(ip);
    return { success: r.success, limit: r.limit, remaining: r.remaining, reset: r.reset };
  }
  const key = `${rule.name}:${ip}`;
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.start >= rule.windowS * 1000) {
    w = { start: now, count: 0 };
    windows.set(key, w);
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= 120_000) windows.delete(k);
  }
  w.count++;
  return { success: w.count <= rule.limit, limit: rule.limit, remaining: Math.max(0, rule.limit - w.count), reset: w.start + rule.windowS * 1000 };
}
