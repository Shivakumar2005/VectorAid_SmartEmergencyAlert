// Road network: built from OpenStreetMap (Overpass JSON) so every route and every car sits on a
// real street centreline, or the labelled offline demo grid. Routing is Dijkstra on the directed
// graph (one-way streets respected), from the exact pin position to the exact pin position.

import { Flat, LL, Polyline, bearingDeg, cardinal, haversineM, wrap180 } from "./geo";

export interface RoadNode {
  id: string;
  lat: number;
  lng: number;
  signal?: boolean; // OpenStreetMap highway=traffic_signals on this node
}

export interface RoadEdge {
  id: string;
  u: string;
  v: string;
  geom: LL[]; // u -> v
  name: string;
  oneway: boolean; // true: only u -> v
  length: number;
  highway: string;
}

export interface Move {
  edge: RoadEdge;
  to: string;
  forward: boolean; // travelling u -> v
}

export type Topology = "3-Way T-Junction" | "3-Way Y-Junction" | "4-Way Crossroad" | "Multi-Arm Intersection";

export interface ArmGeom {
  edgeId: string;
  bearing: number; // outward from the junction, degrees
  label: string; // N, NE, E ...
  name: string;
  neighbor: string; // node at the far end of the edge
}

export const CAR_HIGHWAYS = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
  "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "living_street", "service",
]);

export class RoadGraph {
  readonly nodes = new Map<string, RoadNode>();
  readonly edges: RoadEdge[] = [];
  readonly edgeById = new Map<string, RoadEdge>();
  readonly out = new Map<string, Move[]>(); // legal moves leaving a node
  readonly incident = new Map<string, RoadEdge[]>(); // all edges touching a node (either direction)
  readonly signals: LL[] = []; // traffic signals that are not graph nodes
  private polyCache = new Map<string, Polyline>();

  constructor(readonly source: string, readonly label: string) {}

  addNode(n: RoadNode) {
    this.nodes.set(n.id, n);
    if (!this.out.has(n.id)) this.out.set(n.id, []);
    if (!this.incident.has(n.id)) this.incident.set(n.id, []);
  }

  addEdge(e: Omit<RoadEdge, "length">) {
    const edge: RoadEdge = { ...e, length: 0 };
    edge.length = new Polyline(edge.geom).length;
    this.edges.push(edge);
    this.edgeById.set(edge.id, edge);
    this.out.get(edge.u)!.push({ edge, to: edge.v, forward: true });
    if (!edge.oneway) this.out.get(edge.v)!.push({ edge, to: edge.u, forward: false });
    this.incident.get(edge.u)!.push(edge);
    if (edge.v !== edge.u) this.incident.get(edge.v)!.push(edge);
  }

  poly(edge: RoadEdge): Polyline {
    let p = this.polyCache.get(edge.id);
    if (!p) {
      p = new Polyline(edge.geom);
      this.polyCache.set(edge.id, p);
    }
    return p;
  }

  degree(nodeId: string): number {
    return this.incident.get(nodeId)?.length ?? 0;
  }

  /** Arms of a junction: one per incident edge, bearing measured ~25 m out along the street. */
  arms(nodeId: string): ArmGeom[] {
    const arms: ArmGeom[] = [];
    for (const e of this.incident.get(nodeId) ?? []) {
      const p = this.poly(e);
      const fromU = e.u === nodeId;
      const d = Math.min(25, p.length);
      const far = fromU ? p.at(d) : p.at(p.length - d);
      const node = this.nodes.get(nodeId)!;
      const bearing = bearingDeg([node.lat, node.lng], far);
      arms.push({ edgeId: e.id, bearing, label: cardinal(bearing), name: e.name, neighbor: fromU ? e.v : e.u });
    }
    arms.sort((a, b) => a.bearing - b.bearing);
    // make labels unique (two arms both "N" on a skewed junction become N and N2)
    const seen = new Map<string, number>();
    for (const a of arms) {
      const k = (seen.get(a.label) ?? 0) + 1;
      seen.set(a.label, k);
      if (k > 1) a.label = `${a.label}${k}`;
    }
    return arms;
  }

  topology(nodeId: string): Topology | null {
    const arms = this.arms(nodeId);
    if (arms.length < 3) return null;
    if (arms.length === 4) return "4-Way Crossroad";
    if (arms.length >= 5) return "Multi-Arm Intersection";
    // 3 arms: a T has two arms roughly opposite each other
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        if (Math.abs(wrap180(arms[i].bearing - arms[j].bearing)) >= 150) return "3-Way T-Junction";
    return "3-Way Y-Junction";
  }

  /** Nearest graph node with at least `minDegree` arms. */
  nearestNode(p: LL, minDegree = 1, maxDist = Infinity): { id: string; dist: number } | null {
    let best: { id: string; dist: number } | null = null;
    for (const n of this.nodes.values()) {
      if (this.degree(n.id) < minDegree) continue;
      const d = haversineM(p, [n.lat, n.lng]);
      if (d <= maxDist && (!best || d < best.dist)) best = { id: n.id, dist: d };
    }
    return best;
  }

  /** Nearest point on any street. */
  snap(p: LL): { edge: RoadEdge; s: number; dist: number; point: LL } | null {
    let best: { edge: RoadEdge; s: number; dist: number; point: LL } | null = null;
    for (const e of this.edges) {
      // cheap reject by bounding distance to the edge's first point
      const pr = this.poly(e).project(p);
      if (!best || pr.dist < best.dist) best = { edge: e, s: pr.s, dist: pr.dist, point: this.poly(e).at(pr.s) };
    }
    return best;
  }

  /** Street-aligned route from point a to point b (both snapped onto the nearest street). */
  route(a: LL, b: LL): { pts: LL[]; length: number } | null {
    const A = this.snap(a);
    const B = this.snap(b);
    if (!A || !B) return null;
    const pa = this.poly(A.edge);
    const pb = this.poly(B.edge);

    // same street, straight along it
    if (A.edge.id === B.edge.id) {
      if (B.s >= A.s) return { pts: pa.slice(A.s, B.s), length: B.s - A.s };
      if (!A.edge.oneway) return { pts: pa.slice(B.s, A.s).reverse(), length: A.s - B.s };
    }

    // leave the start street at either end (if allowed), enter the end street from either end
    type Seed = { node: string; cost: number; geom: LL[] };
    const seeds: Seed[] = [{ node: A.edge.v, cost: pa.length - A.s, geom: pa.slice(A.s, pa.length) }];
    if (!A.edge.oneway) seeds.push({ node: A.edge.u, cost: A.s, geom: pa.slice(0, A.s).reverse() });
    const ends: Seed[] = [{ node: B.edge.u, cost: B.s, geom: pb.slice(0, B.s) }];
    if (!B.edge.oneway) ends.push({ node: B.edge.v, cost: pb.length - B.s, geom: pb.slice(B.s, pb.length).reverse() });

    const dist = new Map<string, number>();
    const prev = new Map<string, { from: string | null; move: Move | null; seed: Seed | null }>();
    const heap: [number, string][] = [];
    const push = (c: number, n: string) => {
      heap.push([c, n]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, string] | undefined => {
      if (!heap.length) return undefined;
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (const s of seeds) {
      if (s.cost < (dist.get(s.node) ?? Infinity)) {
        dist.set(s.node, s.cost);
        prev.set(s.node, { from: null, move: null, seed: s });
        push(s.cost, s.node);
      }
    }
    for (;;) {
      const top = pop();
      if (!top) break;
      const [c, n] = top;
      if (c > (dist.get(n) ?? Infinity)) continue;
      for (const mv of this.out.get(n) ?? []) {
        const nc = c + mv.edge.length;
        if (nc < (dist.get(mv.to) ?? Infinity)) {
          dist.set(mv.to, nc);
          prev.set(mv.to, { from: n, move: mv, seed: null });
          push(nc, mv.to);
        }
      }
    }
    let bestEnd: Seed | null = null;
    let bestCost = Infinity;
    for (const e of ends) {
      const c = (dist.get(e.node) ?? Infinity) + e.cost;
      if (c < bestCost) {
        bestCost = c;
        bestEnd = e;
      }
    }
    if (!bestEnd || !isFinite(bestCost)) return null;
    // rebuild
    const chain: LL[][] = [bestEnd.geom];
    let cur = bestEnd.node;
    for (;;) {
      const pr = prev.get(cur)!;
      if (pr.seed) {
        chain.push(pr.seed.geom);
        break;
      }
      const g = pr.move!.forward ? pr.move!.edge.geom : [...pr.move!.edge.geom].reverse();
      chain.push(g);
      cur = pr.from!;
    }
    chain.reverse();
    const pts: LL[] = [];
    for (const g of chain) for (const p of g) {
      const q = pts[pts.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
    }
    if (pts.length < 2) return null;
    return { pts, length: bestCost };
  }

  bounds(): [LL, LL] {
    let s = 90, w = 180, n = -90, e = -180;
    for (const nd of this.nodes.values()) {
      s = Math.min(s, nd.lat); n = Math.max(n, nd.lat);
      w = Math.min(w, nd.lng); e = Math.max(e, nd.lng);
    }
    return [[s, w], [n, e]];
  }
}

// ------------------------------------------------------------------ OpenStreetMap (Overpass)
export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

export function overpassQuery(south: number, west: number, north: number, east: number): string {
  const hw = [...CAR_HIGHWAYS].filter((h) => h !== "service").join("|");
  return `[out:json][timeout:25];(way["highway"~"^(${hw})$"]["area"!="yes"](${south},${west},${north},${east}););(._;>;);out body;`;
}

export function graphFromOverpass(elements: OverpassElement[], label = "OpenStreetMap"): RoadGraph {
  const nodePos = new Map<number, { lat: number; lon: number; tags?: Record<string, string> }>();
  const ways: OverpassElement[] = [];
  for (const el of elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) nodePos.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags });
    else if (el.type === "way" && el.nodes && el.tags && CAR_HIGHWAYS.has(el.tags.highway)) ways.push(el);
  }
  // a node becomes a graph vertex if it ends a way or is shared by several ways
  const use = new Map<number, number>();
  for (const w of ways) for (const id of w.nodes!) use.set(id, (use.get(id) ?? 0) + 1);
  const g = new RoadGraph("osm", label);
  const vertex = (id: number) => {
    const key = `n${id}`;
    if (!g.nodes.has(key)) {
      const p = nodePos.get(id)!;
      g.addNode({ id: key, lat: p.lat, lng: p.lon, signal: p.tags?.highway === "traffic_signals" });
    }
    return key;
  };
  for (const w of ways) {
    const ids = w.nodes!.filter((id) => nodePos.has(id));
    if (ids.length < 2) continue;
    const t = w.tags!;
    let reverse = false;
    let oneway = ["yes", "1", "true"].includes(t.oneway ?? "") || t.junction === "roundabout";
    if (t.oneway === "-1") { oneway = true; reverse = true; }
    if (t.oneway === "no") oneway = false;
    const seq = reverse ? [...ids].reverse() : ids;
    let start = 0;
    let k = 0;
    for (let i = 1; i < seq.length; i++) {
      const isVertex = i === seq.length - 1 || (use.get(seq[i]) ?? 0) > 1;
      if (!isVertex) continue;
      const geom: LL[] = seq.slice(start, i + 1).map((id) => [nodePos.get(id)!.lat, nodePos.get(id)!.lon] as LL);
      const u = vertex(seq[start]);
      const v = vertex(seq[i]);
      if (u !== v || geom.length > 2) {
        g.addEdge({ id: `w${w.id}:${k++}`, u, v, geom, name: t.name ?? t.ref ?? t.highway, oneway, highway: t.highway });
      }
      start = i;
    }
  }
  for (const [, p] of nodePos) {
    if (p.tags?.highway === "traffic_signals") g.signals.push([p.lat, p.lon]);
  }
  return largestComponent(g);
}

function largestComponent(g: RoadGraph): RoadGraph {
  const seen = new Set<string>();
  let best: Set<string> = new Set();
  for (const id of g.nodes.keys()) {
    if (seen.has(id)) continue;
    const comp = new Set<string>([id]);
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of g.incident.get(n) ?? []) {
        for (const m of [e.u, e.v]) if (!seen.has(m)) { seen.add(m); comp.add(m); stack.push(m); }
      }
    }
    if (comp.size > best.size) best = comp;
  }
  if (best.size === g.nodes.size) return g;
  const h = new RoadGraph(g.source, g.label);
  for (const id of best) h.addNode(g.nodes.get(id)!);
  for (const e of g.edges) if (best.has(e.u) && best.has(e.v)) h.addEdge(e);
  h.signals.push(...g.signals);
  return h;
}

// ------------------------------------------------------------------ offline demo grid
// A synthetic street grid, clearly labelled as such: used offline, by the MCP server and by the
// scenario tests. It is NOT a real city; the map hides the background tiles while it is shown.
export const DEMO_ORIGIN: LL = [12.9600, 77.5900];

export function demoGrid(): RoadGraph {
  const g = new RoadGraph("demo", "Demo street grid (synthetic, offline)");
  const flat = new Flat(DEMO_ORIGIN[0], DEMO_ORIGIN[1]);
  const COLS = 6;
  const ROWS = 5;
  const SP = 180; // closer than the 200 m detection radius, so parallel streets test false triggers
  const id = (c: number, r: number) => `g${c}_${r}`;
  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < ROWS; r++) {
      const [lat, lng] = flat.ll(c * SP, r * SP);
      g.addNode({ id: id(c, r), lat, lng });
    }
  const avenues = ["1st Avenue", "2nd Avenue", "3rd Avenue", "4th Avenue", "5th Avenue", "6th Avenue"];
  const streets = ["A Street", "B Street", "C Street", "D Street", "E Street"];
  const line = (a: string, b: string): LL[] => {
    const A = g.nodes.get(a)!;
    const B = g.nodes.get(b)!;
    const n = Math.max(2, Math.round(haversineM([A.lat, A.lng], [B.lat, B.lng]) / 40));
    const out: LL[] = [];
    for (let i = 0; i <= n; i++) out.push([A.lat + ((B.lat - A.lat) * i) / n, A.lng + ((B.lng - A.lng) * i) / n]);
    return out;
  };
  let k = 0;
  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < ROWS - 1; r++)
      g.addEdge({ id: `d${k++}`, u: id(c, r), v: id(c, r + 1), geom: line(id(c, r), id(c, r + 1)), name: avenues[c], oneway: false, highway: "secondary" });
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS - 1; c++)
      g.addEdge({ id: `d${k++}`, u: id(c, r), v: id(c + 1, r), geom: line(id(c, r), id(c + 1, r)), name: streets[r], oneway: false, highway: "tertiary" });
  // a diagonal boulevard out of the centre: makes a 5-arm junction at g2_2
  const [dlat, dlng] = flat.ll(2 * SP + 130, 2 * SP - 130);
  g.addNode({ id: "gdiag", lat: dlat, lng: dlng });
  g.addEdge({ id: `d${k++}`, u: "g2_2", v: "gdiag", geom: line("g2_2", "gdiag"), name: "Hospital Boulevard", oneway: false, highway: "primary" });
  return g;
}
