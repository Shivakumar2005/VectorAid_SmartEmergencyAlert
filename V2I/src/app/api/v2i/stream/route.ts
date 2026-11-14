// GET /api/v2i/stream  - Server-Sent Events with the roadside units' latest telemetry.
// Ends after ~55 s (function time limit); the browser's EventSource reconnects by itself.
import { serverEnv } from "@/lib/server/env";
import { listRsu, storeKind, version } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // safe on every Vercel plan; the browser reconnects

const POLL_MS = 2000;
const LIFETIME_MS = 55_000;

export async function GET(req: Request) {
  const enc = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const send = (s: string) => {
        if (!closed) ctrl.enqueue(enc.encode(s));
      };
      req.signal.addEventListener("abort", () => {
        closed = true;
      });
      send("retry: 3000\n\n");
      send(`event: hello\ndata: ${JSON.stringify({ store: storeKind(), telemetry: Boolean(serverEnv.hmacSecret()) })}\n\n`);
      const t0 = Date.now();
      let lastVer = -1;
      let lastList = 0;
      let beat = Date.now();
      while (!closed && Date.now() - t0 < LIFETIME_MS) {
        try {
          const ver = await version();
          // also re-list every 15 s so units that stopped reporting (60 s expiry) drop off the screen
          if (ver !== lastVer || Date.now() - lastList > 15_000) {
            lastVer = ver;
            lastList = Date.now();
            send(`event: rsu\ndata: ${JSON.stringify(await listRsu())}\n\n`);
          }
        } catch {
          send(`event: problem\ndata: ${JSON.stringify({ error: "telemetry store unreachable" })}\n\n`);
        }
        if (Date.now() - beat > 15_000) {
          send(": keep-alive\n\n");
          beat = Date.now();
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (!closed) {
        closed = true;
        ctrl.close();
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
