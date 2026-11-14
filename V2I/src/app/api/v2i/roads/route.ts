// GET /api/v2i/roads?s=&w=&n=&e=  - drivable OpenStreetMap roads in a box (max ~4.4 km a side),
// fetched from Overpass on the server (falling back to other public instances when one is busy)
// and trimmed. The browser builds its road graph from it.
// Cached by the CDN for a day, so the same box does not hit Overpass again.
import { overpassQuery } from "@/lib/roadGraph";
import { serverEnv } from "@/lib/server/env";
import { json } from "@/lib/server/http";
import { RoadsQuery, issues } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 15 * 1024 * 1024;
const BUDGET_MS = 52_000; // stay inside maxDuration
const PER_TRY_MS = 20_000;

interface El { type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> }

/** Asks the Overpass servers one after another; a busy one (429, 406, 5xx, timeout) is skipped. */
async function fetchOverpass(query: string): Promise<{ text: string; server: string } | { error: string }> {
  const t0 = Date.now();
  const tried: string[] = [];
  for (const url of serverEnv.overpassUrls()) {
    const left = BUDGET_MS - (Date.now() - t0);
    if (left < 4000) break;
    const host = new URL(url).host;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "v2i-preemption-platform/1.0 (student traffic-signal demo)", Accept: "application/json" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(Math.min(PER_TRY_MS, left)),
        cache: "no-store",
      });
      if (!r.ok) { tried.push(`${host}: HTTP ${r.status}`); continue; }
      const text = await r.text();
      if (!text.trimStart().startsWith("{")) { tried.push(`${host}: not JSON`); continue; }
      return { text, server: host };
    } catch (err) {
      tried.push(`${host}: ${err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable"}`);
    }
  }
  return { error: `no Overpass server answered (${tried.join("; ") || "out of time"}). Try a smaller area or again in a minute.` };
}

export async function GET(req: Request) {
  const q = RoadsQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return json({ error: "invalid box", issues: issues(q.error) }, 400);
  const { s, w, n, e } = q.data;
  const got = await fetchOverpass(overpassQuery(s, w, n, e));
  if ("error" in got) return json({ error: got.error }, 502);
  if (got.text.length > MAX_BYTES) return json({ error: "too many roads in this box: zoom in" }, 413);
  let data: { elements?: El[]; remark?: string };
  try {
    data = JSON.parse(got.text);
  } catch {
    return json({ error: "Overpass returned bad data" }, 502);
  }
  // Overpass reports its own timeouts/memory limits as a "remark" with partial data
  if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) return json({ error: `Overpass (${got.server}) gave up on this area: zoom in and try again` }, 502);
  const keepTag = ["highway", "name", "oneway", "junction", "ref"];
  const elements = (data.elements ?? []).flatMap((el): El[] => {
    if (el.type === "node" && Number.isFinite(el.lat) && Number.isFinite(el.lon))
      return [{ type: "node", id: el.id, lat: el.lat, lon: el.lon, ...(el.tags?.highway === "traffic_signals" ? { tags: { highway: "traffic_signals" } } : {}) }];
    if (el.type === "way" && Array.isArray(el.nodes) && el.tags?.highway)
      return [{ type: "way", id: el.id, nodes: el.nodes, tags: Object.fromEntries(Object.entries(el.tags).filter(([k]) => keepTag.includes(k))) }];
    return [];
  });
  return json({ bbox: [s, w, n, e], server: got.server, elements, attribution: "© OpenStreetMap contributors (ODbL)" }, 200, {
    "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
  });
}
