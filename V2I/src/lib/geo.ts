// Geodesy and polyline helpers shared by the browser simulation, the API routes, the MCP
// server and the tests. Plain functions, no DOM.

export type LL = [number, number]; // [lat, lng]

export const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function haversineM(a: LL, b: LL): number {
  const dLat = (b[0] - a[0]) * D2R;
  const dLon = (b[1] - a[1]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.atan2(Math.sqrt(s), Math.sqrt(Math.max(0, 1 - s)));
}

/** Initial compass bearing a -> b, degrees 0..360 (0 = north, 90 = east). */
export function bearingDeg(a: LL, b: LL): number {
  const p1 = a[0] * D2R;
  const p2 = b[0] * D2R;
  const dl = (b[1] - a[1]) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Wrap an angle to (-180, 180]. */
export function wrap180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

export type Turn = "STRAIGHT" | "LEFT" | "RIGHT" | "U_TURN";

/** Turn from the heading on the way in to the bearing on the way out.
 *  dTheta = wrap180(out - in): negative = left (counter-clockwise), positive = right. */
export function classifyTurn(inBearing: number, outBearing: number): { turn: Turn; dTheta: number } {
  const dTheta = wrap180(outBearing - inBearing);
  const a = Math.abs(dTheta);
  const turn: Turn = a <= 30 ? "STRAIGHT" : a >= 150 ? "U_TURN" : dTheta < 0 ? "LEFT" : "RIGHT";
  return { turn, dTheta };
}

export function cardinal(deg: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Flat metres around a reference point: accurate to well under 1 % over a few km. */
export class Flat {
  readonly kx: number;
  readonly ky: number;
  constructor(readonly lat0: number, readonly lng0: number) {
    this.ky = EARTH_R * D2R;
    this.kx = this.ky * Math.cos(lat0 * D2R);
  }
  xy(p: LL): [number, number] {
    return [(p[1] - this.lng0) * this.kx, (p[0] - this.lat0) * this.ky];
  }
  ll(x: number, y: number): LL {
    return [this.lat0 + y / this.ky, this.lng0 + x / this.kx];
  }
}

/** A polyline with cumulative arc length, for "where is the vehicle along its route". */
export class Polyline {
  readonly pts: LL[];
  readonly cum: number[];
  readonly length: number;
  private readonly flat: Flat;
  private readonly xy: [number, number][];

  constructor(pts: LL[]) {
    if (pts.length < 2) throw new Error("a polyline needs at least 2 points");
    // drop exact duplicates, they break bearings
    const clean: LL[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const q = clean[clean.length - 1];
      if (p[0] !== q[0] || p[1] !== q[1]) clean.push(p);
    }
    if (clean.length < 2) clean.push([pts[0][0] + 1e-7, pts[0][1]]);
    this.pts = clean;
    this.flat = new Flat(clean[0][0], clean[0][1]);
    this.xy = clean.map((p) => this.flat.xy(p));
    this.cum = [0];
    for (let i = 1; i < clean.length; i++) {
      const [ax, ay] = this.xy[i - 1];
      const [bx, by] = this.xy[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(bx - ax, by - ay));
    }
    this.length = this.cum[this.cum.length - 1];
  }

  private seg(s: number): number {
    let lo = 0;
    let hi = this.cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Point at arc length s (clamped). */
  at(s: number): LL {
    const sc = Math.max(0, Math.min(this.length, s));
    const i = this.seg(sc);
    const L = this.cum[i + 1] - this.cum[i];
    const t = L > 0 ? (sc - this.cum[i]) / L : 0;
    const [ax, ay] = this.xy[i];
    const [bx, by] = this.xy[i + 1];
    return this.flat.ll(ax + t * (bx - ax), ay + t * (by - ay));
  }

  /** Compass bearing of the segment containing arc length s. */
  bearingAt(s: number): number {
    const i = this.seg(Math.max(0, Math.min(this.length - 1e-6, s)));
    const [ax, ay] = this.xy[i];
    const [bx, by] = this.xy[i + 1];
    return (Math.atan2(bx - ax, by - ay) * R2D + 360) % 360;
  }

  /** Bearing from s - span to s (smoothed over curvy geometry). */
  bearingBetween(s1: number, s2: number): number {
    const a = this.flat.xy(this.at(s1));
    const b = this.flat.xy(this.at(s2));
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) return this.bearingAt(s2);
    return (Math.atan2(b[0] - a[0], b[1] - a[1]) * R2D + 360) % 360;
  }

  /** Closest point on the polyline: arc length and lateral distance in metres. */
  project(p: LL): { s: number; dist: number } {
    const [px, py] = this.flat.xy(p);
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i < this.xy.length - 1; i++) {
      const [ax, ay] = this.xy[i];
      const [bx, by] = this.xy[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d < best) {
        best = d;
        bestS = this.cum[i] + t * Math.sqrt(L2);
      }
    }
    return { s: bestS, dist: best };
  }

  /** Sub-polyline between arc lengths a and b. */
  slice(a: number, b: number): LL[] {
    const s0 = Math.max(0, Math.min(a, b));
    const s1 = Math.min(this.length, Math.max(a, b));
    const out: LL[] = [this.at(s0)];
    for (let i = 0; i < this.cum.length; i++) if (this.cum[i] > s0 && this.cum[i] < s1) out.push(this.pts[i]);
    out.push(this.at(s1));
    return out;
  }
}

export function pathLength(pts: LL[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += haversineM(pts[i - 1], pts[i]);
  return L;
}
