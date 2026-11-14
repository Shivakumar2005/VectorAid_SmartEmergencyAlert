import "server-only";

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

/** Browser POSTs must come from this site (a cross-site page cannot spend our ORS quota). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // not a browser (curl, a device): the rate limit still applies
  try {
    return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  } catch {
    return false;
  }
}

/** Reads at most `max` bytes of the body; null if it is larger. */
export async function readBody(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  const text = await req.text();
  return new TextEncoder().encode(text).length > max ? null : text;
}
