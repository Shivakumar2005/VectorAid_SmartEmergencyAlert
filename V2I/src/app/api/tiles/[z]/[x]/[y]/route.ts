// GET /api/tiles/{z}/{x}/{y}  - optional OpenStreetMap tile proxy.
//
// OFF unless TILE_PROXY_CONTACT is set. The OSM tile policy "generally does not recommend" proxies;
// a proxy must send a contactable User-Agent, keep the browser's Referer and cache tiles for at
// least 7 days (https://operations.osmfoundation.org/policies/tiles/). By default the map loads
// tiles straight from tile.openstreetmap.org, which is what that policy expects.
import { serverEnv } from "@/lib/server/env";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";

const WEEK_S = 7 * 86400;

export async function GET(req: Request, ctx: { params: Promise<{ z: string; x: string; y: string }> }) {
  const contact = serverEnv.tileContact();
  if (!contact) return json({ error: "tile proxy disabled (set TILE_PROXY_CONTACT to enable it)" }, 404);
  const { z, x, y } = await ctx.params;
  const [Z, X, Y] = [z, x, y.replace(/\.png$/, "")].map((v) => (/^\d{1,7}$/.test(v) ? Number(v) : NaN));
  if (![Z, X, Y].every(Number.isInteger) || Z > 19 || X >= 2 ** Z || Y >= 2 ** Z) return json({ error: "bad tile address" }, 400);
  const headers: Record<string, string> = { "User-Agent": `v2i-preemption-platform/1.0 (+${contact})` };
  const referer = req.headers.get("referer");
  if (referer) headers.Referer = referer;
  for (const h of ["if-none-match", "if-modified-since"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  try {
    const r = await fetch(`https://tile.openstreetmap.org/${Z}/${X}/${Y}.png`, { headers, signal: AbortSignal.timeout(10_000) });
    if (r.status === 304) return new Response(null, { status: 304, headers: { "Cache-Control": `public, max-age=${WEEK_S}` } });
    if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) return json({ error: `tile server answered HTTP ${r.status}` }, 502);
    const out = new Headers({ "Content-Type": r.headers.get("content-type")!, "Cache-Control": `public, max-age=${WEEK_S}, s-maxage=${WEEK_S}` });
    for (const h of ["etag", "last-modified"]) {
      const v = r.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(r.body, { status: 200, headers: out });
  } catch {
    return json({ error: "tile server unreachable" }, 502);
  }
}
