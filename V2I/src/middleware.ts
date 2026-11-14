// Runs before every request:
//  1. a fresh nonce and a strict Content-Security-Policy for pages (Next.js puts the nonce on its
//     own <script> tags; anything else - an injected script - is blocked)
//  2. per-IP rate limits for /api/* (src/lib/server/rateLimit.ts)
import { NextResponse, type NextRequest } from "next/server";
import { checkLimit, ruleFor } from "@/lib/server/rateLimit";

function csp(nonce: string, https: boolean): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/")) {
    const rule = ruleFor(path);
    if (rule) {
      try {
        const r = await checkLimit(rule, clientIp(req), { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
        const h = { "X-RateLimit-Limit": String(r.limit), "X-RateLimit-Remaining": String(r.remaining) };
        if (!r.success) {
          const retry = Math.max(1, Math.ceil((r.reset - Date.now()) / 1000));
          return NextResponse.json({ error: "too many requests" }, { status: 429, headers: { ...h, "Retry-After": String(retry) } });
        }
        const res = NextResponse.next();
        for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
        return res;
      } catch {
        return NextResponse.next(); // limiter store down: fail open rather than take the site down
      }
    }
    return NextResponse.next();
  }

  const nonce = btoa(crypto.randomUUID());
  const https = req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const policy = csp(nonce, https);
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", policy);
  return res;
}

export const config = {
  matcher: [
    { source: "/((?!_next/static|_next/image|favicon.ico|fonts/).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] },
  ],
};
