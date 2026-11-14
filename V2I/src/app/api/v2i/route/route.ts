// POST /api/v2i/route  {start:[lat,lng], end:[lat,lng]}
// Street routing through OpenRouteService with the key kept on the server. If the key is missing
// or ORS fails, answers {fallback:true} and the browser routes on its own OpenStreetMap graph.
import { haversineM } from "@/lib/geo";
import { serverEnv } from "@/lib/server/env";
import { json, readBody, sameOrigin } from "@/lib/server/http";
import { RouteRequest, issues } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORS_URL = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";
const MAX_TRIP_M = 50_000;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);
  const text = await readBody(req, 2048);
  if (text === null) return json({ error: "body too large" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  const parsed = RouteRequest.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid request", issues: issues(parsed.error) }, 400);
  const { start, end } = parsed.data;
  if (haversineM(start, end) > MAX_TRIP_M) return json({ error: `start and destination are more than ${MAX_TRIP_M / 1000} km apart` }, 400);

  const key = serverEnv.orsKey();
  if (!key) return json({ source: "graph", fallback: true, reason: "ORS_API_KEY is not set on the server" });
  try {
    const r = await fetch(ORS_URL, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/geo+json, application/json" },
      body: JSON.stringify({ coordinates: [[start[1], start[0]], [end[1], end[0]]], instructions: false }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    // never forward ORS's own error body: only the status code
    if (!r.ok) return json({ source: "graph", fallback: true, reason: `OpenRouteService answered HTTP ${r.status}` });
    const g = (await r.json()) as { features?: { geometry?: { coordinates?: unknown }; properties?: { summary?: { distance?: number; duration?: number } } }[] };
    const f = g.features?.[0];
    const coords = f?.geometry?.coordinates;
    const ok =
      Array.isArray(coords) && coords.length >= 2 && coords.length <= 50_000 &&
      coords.every((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180);
    if (!ok) return json({ source: "graph", fallback: true, reason: "OpenRouteService returned no usable route" });
    const points = (coords as number[][]).map((c) => [c[1], c[0]] as [number, number]);
    return json({ source: "ors", fallback: false, points, distanceM: f?.properties?.summary?.distance ?? null, durationS: f?.properties?.summary?.duration ?? null });
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "OpenRouteService timed out" : "OpenRouteService unreachable";
    return json({ source: "graph", fallback: true, reason });
  }
}
