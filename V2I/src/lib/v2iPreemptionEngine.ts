// V2I preemption engine: junction controllers (one ESP32-S3 RSU each), ambulances (ESP32-S3 OBU
// each) and civilian traffic, stepped in fixed time steps. The same engine drives the browser
// simulation, the MCP tools and the scenario tests; the roadside firmware implements the same rules.
//
// Signal plan per junction: split phasing - each arm gets its own green in turn
// (green 12 s, yellow 3 s, all-red 2 s). Only one arm is ever green, so no movement can conflict.
//
// Route-aware preemption: a junction reacts to an ambulance only if the junction lies ON that
// ambulance's planned route (within 25 m of its polyline) and the ambulance is <= 200 m before it.
// Then: the arm it arrives on is served next - the arm that is green (after its 5 s minimum green)
// goes yellow -> all-red -> the ambulance's arm goes green and is held until the ambulance is 15 m
// past the junction; then the cycle resumes with the next arm. Junctions within 200 m that are NOT
// on the route never react (counted as "false alerts filtered").
// Several ambulances at one junction: the one that will arrive first (ETA, severity bonus) is
// served first; whoever is being served keeps the junction until it has passed.

import { LL, Polyline, Turn, bearingDeg, classifyTurn, haversineM, wrap180 } from "./geo";
import { ArmGeom, Move, RoadEdge, RoadGraph, Topology } from "./roadGraph";
import { V2IPacket, encodePacket } from "./rf24PacketCodec";

export const TIMING = { GREEN_S: 12, YELLOW_S: 3, ALL_RED_S: 2, MIN_GREEN_S: 5, MAX_HOLD_S: 120, LOCKOUT_S: 30 };
export const DETECT_M = 200;
export const ON_ROUTE_M = 25;
export const PASS_M = 15;
export const STOP_LINE_M = 12;
export const JUNCTION_SNAP_M = 80;
export const GPIO_POOL = [4, 5, 6, 7, 15, 16, 17, 18, 8, 9, 10, 11, 12, 13, 14, 21];
export const MAX_ARMS = Math.floor(GPIO_POOL.length / 3);
const SEVERITY_BONUS_S = 4; // each severity level above 1 counts as arriving 4 s earlier

export type Lamp = "R" | "Y" | "G";
export type Phase = "GREEN" | "YELLOW" | "ALL_RED";
export type CtrlMode = "NORMAL" | "PREEMPT" | "RECOVER";
export type Density = "off" | "low" | "medium" | "high";
export const DENSITY_COUNT: Record<Density, number> = { off: 0, low: 18, medium: 36, high: 60 };

// ------------------------------------------------------------------ signal controller
export class SignalController {
  phase: Phase = "GREEN";
  greenArm = 0;
  t = 0;
  mode: CtrlMode = "NORMAL";
  preemptArm: number | null = null;
  holdT = 0;

  constructor(readonly nArms: number, offsetS = 0) {
    // start offsetS seconds into the normal cycle so junctions are not all in step
    const cycle = nArms * (TIMING.GREEN_S + TIMING.YELLOW_S + TIMING.ALL_RED_S);
    let t = ((offsetS % cycle) + cycle) % cycle;
    for (let a = 0; a < nArms; a++) {
      for (const [ph, d] of [["GREEN", TIMING.GREEN_S], ["YELLOW", TIMING.YELLOW_S], ["ALL_RED", TIMING.ALL_RED_S]] as [Phase, number][]) {
        if (t < d) { this.phase = ph; this.greenArm = a; this.t = t; return; }
        t -= d;
      }
    }
  }

  lamp(arm: number): Lamp {
    if (arm !== this.greenArm) return "R";
    return this.phase === "GREEN" ? "G" : this.phase === "YELLOW" ? "Y" : "R";
  }

  /** Seconds left in the current phase (for the countdown display). */
  remaining(): number {
    if (this.phase === "GREEN") {
      if (this.mode === "PREEMPT" && this.preemptArm === this.greenArm) return Infinity;
      return Math.max(0, TIMING.GREEN_S - this.t);
    }
    return Math.max(0, (this.phase === "YELLOW" ? TIMING.YELLOW_S : TIMING.ALL_RED_S) - this.t);
  }

  private go(phase: Phase, arm = this.greenArm) {
    this.phase = phase;
    this.greenArm = arm;
    this.t = 0;
  }

  /** req = arm to serve for an ambulance, or null. */
  step(dt: number, req: number | null) {
    this.t += dt;
    if (req !== null) {
      if (this.mode !== "PREEMPT") this.holdT = 0;
      this.mode = "PREEMPT";
      this.preemptArm = req;
      this.holdT += dt;
    } else if (this.mode === "PREEMPT") {
      this.mode = "RECOVER";
    }
    switch (this.phase) {
      case "GREEN":
        if (req !== null) {
          if (this.greenArm !== req && this.t >= TIMING.MIN_GREEN_S) this.go("YELLOW");
        } else if (this.mode === "RECOVER") {
          if (this.greenArm === this.preemptArm) this.go("YELLOW"); // end the ambulance's green now
          else { this.mode = "NORMAL"; this.preemptArm = null; }
        } else if (this.t >= TIMING.GREEN_S) this.go("YELLOW");
        break;
      case "YELLOW":
        if (this.t >= TIMING.YELLOW_S) this.go("ALL_RED");
        break;
      case "ALL_RED":
        if (this.t >= TIMING.ALL_RED_S) {
          const next = req !== null ? req : (this.greenArm + 1) % this.nArms;
          this.go("GREEN", next);
          if (this.mode === "RECOVER") { this.mode = "NORMAL"; this.preemptArm = null; }
        }
        break;
    }
  }
}

// ------------------------------------------------------------------ junctions
export interface Arm extends ArmGeom {
  idx: number;
  gpio: [number, number, number]; // R, Y, G
  queue: number; // cars stopped on this approach
}

export interface Junction {
  id: string;
  name: string;
  nodeId: string;
  lat: number;
  lng: number;
  topology: Topology;
  arms: Arm[];
  ctrl: SignalController;
  served: string | null; // ambulance holding the junction
  queue: string[]; // ambulances waiting for it
  waiting: Record<string, number>; // ambulance -> distance, for display
  lockout: Map<string, number>;
  offRouteNear: Set<string>;
}

// ------------------------------------------------------------------ ambulances
export interface RouteJunction {
  jid: string;
  s: number; // arc length of the junction centre on the route
  approachArm: number;
  exitArm: number;
  inBearing: number;
  outBearing: number;
  turn: Turn;
  dTheta: number;
  greenOnArrival?: boolean;
  passed?: boolean;
}

export class Ambulance {
  s = 0;
  v = 0; // m/s
  siren = true;
  arrived = false;
  waitedS = 0;
  stops = 0;
  private wasStopped = false;
  routeJunctions: RouteJunction[] = [];
  readonly route: Polyline;

  constructor(
    readonly id: string,
    readonly num: number,
    routePts: LL[],
    public targetKmh: number,
    public severity: number,
    readonly color: string,
    startOffsetM = 0,
  ) {
    this.route = new Polyline(routePts);
    this.s = Math.max(0, Math.min(startOffsetM, this.route.length));
    this.v = targetKmh / 3.6;
  }

  get pos(): LL { return this.route.at(this.s); }
  get heading(): number { return this.route.bearingAt(this.s); }
  get dest(): LL { return this.route.pts[this.route.pts.length - 1]; }

  next(): RouteJunction | null {
    return this.routeJunctions.find((rj) => rj.s - this.s > -PASS_M) ?? null;
  }

  markStopped(stopped: boolean) {
    if (stopped && !this.wasStopped) this.stops++;
    this.wasStopped = stopped;
  }
}

// ------------------------------------------------------------------ civilian cars
export interface Car {
  id: number;
  edge: RoadEdge;
  forward: boolean;
  s: number;
  v: number;
  vmax: number;
  stopped: boolean;
}

export interface EngineEvent {
  t: number;
  level: "info" | "warn" | "preempt" | "error";
  msg: string;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AMB_COLORS = ["#ef4444", "#f97316", "#e11d48", "#d946ef", "#f43f5e"];

// ------------------------------------------------------------------ the engine
export class V2IEngine {
  t = 0;
  readonly junctions = new Map<string, Junction>();
  readonly ambulances = new Map<string, Ambulance>();
  cars: Car[] = [];
  density: Density = "off";
  events: EngineEvent[] = [];
  kpi = { preemptions: 0, falseAlertsFiltered: 0, ambulanceStops: 0, conflicts: 0, greenOnArrival: 0, arrivals: 0 };
  private rng: () => number;
  private nextCarId = 1;
  private junctionByNode = new Map<string, Junction>();
  private lastLamps = new Map<string, Lamp[]>();

  constructor(readonly graph: RoadGraph, seed = 7) {
    this.rng = mulberry32(seed);
  }

  log(level: EngineEvent["level"], msg: string) {
    this.events.push({ t: Math.round(this.t * 10) / 10, level, msg });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  // ---------------------------------------------------------------- junctions
  addJunctionAt(p: LL, opts: { id?: string; name?: string } = {}): { ok: true; junction: Junction } | { ok: false; error: string } {
    const near = this.graph.nearestNode(p, 3, JUNCTION_SNAP_M);
    if (!near) return { ok: false, error: `no junction (3 or more roads) within ${JUNCTION_SNAP_M} m of that point` };
    if (this.junctionByNode.has(near.id)) return { ok: false, error: `that junction already has ${this.junctionByNode.get(near.id)!.id}` };
    const geoms = this.graph.arms(near.id);
    if (geoms.length > MAX_ARMS) return { ok: false, error: `${geoms.length} arms - one ESP32-S3 drives at most ${MAX_ARMS} (${GPIO_POOL.length} GPIOs)` };
    const topology = this.graph.topology(near.id)!;
    const node = this.graph.nodes.get(near.id)!;
    let n = this.junctions.size + 1;
    let id = opts.id ?? `J${String(n).padStart(2, "0")}`;
    while (this.junctions.has(id)) id = `J${String(++n).padStart(2, "0")}`;
    const names = [...new Set(geoms.map((a) => a.name).filter(Boolean))];
    const arms: Arm[] = geoms.map((a, i) => ({ ...a, idx: i, gpio: [GPIO_POOL[3 * i], GPIO_POOL[3 * i + 1], GPIO_POOL[3 * i + 2]], queue: 0 }));
    const j: Junction = {
      id,
      name: opts.name ?? (names.slice(0, 2).join(" & ") || `Junction ${id}`),
      nodeId: near.id,
      lat: node.lat,
      lng: node.lng,
      topology,
      arms,
      ctrl: new SignalController(arms.length, this.junctions.size * 7.3),
      served: null,
      queue: [],
      waiting: {},
      lockout: new Map(),
      offRouteNear: new Set(),
    };
    this.junctions.set(id, j);
    this.junctionByNode.set(near.id, j);
    for (const a of this.ambulances.values()) this.planJunctions(a);
    this.log("info", `${id} placed at ${j.name}: ${topology}, ${arms.length} arms (${arms.map((a) => a.label).join(" ")})`);
    return { ok: true, junction: j };
  }

  removeJunction(id: string) {
    const j = this.junctions.get(id);
    if (!j) return;
    this.junctions.delete(id);
    this.junctionByNode.delete(j.nodeId);
    for (const a of this.ambulances.values()) this.planJunctions(a);
  }

  /** RSUs at the OpenStreetMap traffic signals (or, on the demo grid, a spread of junctions). */
  autoPlaceJunctions(max = 12): number {
    const before = this.junctions.size;
    const pts: LL[] = [];
    for (const n of this.graph.nodes.values()) if (n.signal && this.graph.degree(n.id) >= 3) pts.push([n.lat, n.lng]);
    pts.push(...this.graph.signals);
    if (!pts.length) for (const n of this.graph.nodes.values()) if (this.graph.degree(n.id) >= 3) pts.push([n.lat, n.lng]);
    // most central first, so the units are not all bunched in one corner of the loaded area
    const [[s, w], [n, e]] = this.graph.bounds();
    const c: LL = [(s + n) / 2, (w + e) / 2];
    pts.sort((a, b) => haversineM(a, c) - haversineM(b, c));
    for (const p of pts) {
      if (this.junctions.size - before >= max) break;
      const near = this.graph.nearestNode(p, 3, 40);
      if (near && !this.junctionByNode.has(near.id)) this.addJunctionAt(p);
    }
    return this.junctions.size - before;
  }

  // ---------------------------------------------------------------- ambulances
  dispatch(o: { id?: string; num?: number; start?: LL; dest?: LL; routePts?: LL[]; speedKmh?: number; severity?: number; startOffsetM?: number }):
    { ok: true; ambulance: Ambulance } | { ok: false; error: string } {
    let pts = o.routePts;
    if (!pts) {
      if (!o.start || !o.dest) return { ok: false, error: "need start and destination (or route points)" };
      const r = this.graph.route(o.start, o.dest);
      if (!r) return { ok: false, error: "no route between those points on this road network" };
      pts = r.pts;
    }
    if (pts.length < 2) return { ok: false, error: "route too short" };
    let num = o.num ?? 101;
    while (!o.num && [...this.ambulances.values()].some((a) => a.num === num)) num++;
    const id = o.id ?? `AMB-${num}`;
    if (!/^AMB-[0-9A-Z]{1,6}$/.test(id)) return { ok: false, error: "ambulance id must look like AMB-101" };
    if (this.ambulances.has(id)) this.ambulances.delete(id);
    const amb = new Ambulance(id, num, pts, Math.max(5, Math.min(120, o.speedKmh ?? 45)), Math.max(1, Math.min(3, o.severity ?? 2)),
      AMB_COLORS[this.ambulances.size % AMB_COLORS.length], o.startOffsetM ?? 0);
    this.planJunctions(amb);
    this.ambulances.set(id, amb);
    const list = amb.routeJunctions.map((r) => `${r.jid} ${r.turn}`).join(", ") || "none";
    this.log("info", `${id} dispatched: ${(amb.route.length / 1000).toFixed(2)} km, severity ${amb.severity}, junctions on route: ${list}`);
    return { ok: true, ambulance: amb };
  }

  /** Which junctions lie on this ambulance's route, where, and which arms it uses. */
  planJunctions(amb: Ambulance) {
    const out: RouteJunction[] = [];
    for (const j of this.junctions.values()) {
      const pr = amb.route.project([j.lat, j.lng]);
      if (pr.dist > ON_ROUTE_M || pr.s < 5 || pr.s > amb.route.length - 1) continue;
      const span = 30;
      const inB = amb.route.bearingBetween(pr.s - span, pr.s);
      const outB = pr.s + 5 < amb.route.length ? amb.route.bearingBetween(pr.s, pr.s + span) : inB;
      const fromB = (inB + 180) % 360; // the arm the ambulance comes out of points back along its path
      const pick = (b: number) => j.arms.reduce((best, a) => (Math.abs(wrap180(a.bearing - b)) < Math.abs(wrap180(j.arms[best].bearing - b)) ? a.idx : best), 0);
      const { turn, dTheta } = classifyTurn(inB, outB);
      out.push({ jid: j.id, s: pr.s, approachArm: pick(fromB), exitArm: pick(outB), inBearing: inB, outBearing: outB, turn, dTheta });
    }
    out.sort((a, b) => a.s - b.s);
    amb.routeJunctions = out;
  }

  removeAmbulance(id: string) { this.ambulances.delete(id); }

  /** The radio frame this ambulance's OBU would transmit right now. */
  txPacket(amb: Ambulance): { packet: V2IPacket; bytes: Uint8Array } {
    const nx = amb.next();
    const j = nx ? this.junctions.get(nx.jid) : null;
    const [lat, lng] = amb.pos;
    const [dlat, dlng] = amb.dest;
    const packet: V2IPacket = {
      ambulanceId: amb.num & 0xff,
      lat, lng,
      headingDeg: amb.heading,
      speedKmh: amb.v * 3.6,
      nextWpLat: j ? j.lat : 0,
      nextWpLng: j ? j.lng : 0,
      destLat: dlat, destLng: dlng,
      turn: nx ? nx.turn : "NONE",
      severity: amb.siren && !amb.arrived ? amb.severity : 0,
    };
    return { packet, bytes: encodePacket(packet) };
  }

  // ---------------------------------------------------------------- civilian traffic
  setDensity(d: Density) {
    this.density = d;
    const want = DENSITY_COUNT[d];
    const edges = this.graph.edges.filter((e) => e.length > 30);
    if (!edges.length) { this.cars = []; return; }
    while (this.cars.length > want) this.cars.pop();
    let guard = 0;
    while (this.cars.length < want && guard++ < want * 20) {
      const e = edges[Math.floor(this.rng() * edges.length)];
      const forward = e.oneway ? true : this.rng() < 0.5;
      const s = 10 + this.rng() * Math.max(1, e.length - 40);
      if (this.cars.some((c) => c.edge.id === e.id && c.forward === forward && Math.abs(c.s - s) < 12)) continue;
      const vmax = (28 + this.rng() * 14) / 3.6;
      this.cars.push({ id: this.nextCarId++, edge: e, forward, s, v: vmax * 0.6, vmax, stopped: false });
    }
  }

  carPos(c: Car): LL {
    const p = this.graph.poly(c.edge);
    return p.at(c.forward ? c.s : p.length - c.s);
  }

  private nextMove(node: string, came: RoadEdge): Move | null {
    const moves = this.graph.out.get(node) ?? [];
    const ahead = moves.filter((m) => m.edge.id !== came.id);
    const pool = ahead.length ? ahead : moves;
    if (!pool.length) return null;
    return pool[Math.floor(this.rng() * pool.length)];
  }

  private stepCars(dt: number) {
    // leader on the same directed edge
    const lanes = new Map<string, Car[]>();
    for (const c of this.cars) {
      const k = `${c.edge.id}|${c.forward ? 1 : 0}`;
      if (!lanes.has(k)) lanes.set(k, []);
      lanes.get(k)!.push(c);
    }
    for (const lane of lanes.values()) lane.sort((a, b) => b.s - a.s);
    for (const j of this.junctions.values()) for (const a of j.arms) a.queue = 0;

    for (const lane of lanes.values()) {
      const before = lane.map((c) => c.s); // positions at the start of the step
      for (let i = 0; i < lane.length; i++) {
        const c = lane[i];
        const L = c.edge.length;
        const endNode = c.forward ? c.edge.v : c.edge.u;
        let gap = Infinity;
        if (i > 0) gap = before[i - 1] - c.s - 7; // 7 m: car length + minimum gap
        const j = this.junctionByNode.get(endNode);
        let armIdx = -1;
        if (j) {
          armIdx = j.arms.findIndex((a) => a.edgeId === c.edge.id);
          const lamp = armIdx >= 0 ? j.ctrl.lamp(armIdx) : "G";
          const stopAt = L - STOP_LINE_M;
          // red, or yellow that it can still stop for: hold at the stop line
          if (lamp !== "G" && c.s <= stopAt + 0.5) {
            const canStop = lamp === "R" || (stopAt - c.s) > (c.v * c.v) / (2 * 4.5);
            if (canStop) gap = Math.min(gap, stopAt - c.s);
          }
        }
        let vTarget = c.vmax;
        if (gap < Infinity) vTarget = Math.min(vTarget, Math.sqrt(2 * 3.0 * Math.max(0, gap)));
        const acc = vTarget > c.v ? 2.0 : -6.0;
        c.v = Math.max(0, acc > 0 ? Math.min(vTarget, c.v + acc * dt) : Math.max(vTarget, c.v + acc * dt));
        if (gap <= 0.3) c.v = 0;
        c.s += c.v * dt;
        const leader = i > 0 ? lane[i - 1] : null;
        if (leader && leader.edge === c.edge && leader.forward === c.forward) c.s = Math.min(c.s, Math.max(before[i], leader.s - 5));
        c.stopped = c.v < 0.5;
        if (j && armIdx >= 0 && c.stopped && L - c.s < 90) j.arms[armIdx].queue++;
        if (c.s >= L) {
          const mv = this.nextMove(endNode, c.edge);
          if (!mv) { c.s = L; c.v = 0; continue; }
          c.s = Math.min(c.s - L, mv.edge.length * 0.5);
          c.edge = mv.edge;
          c.forward = mv.forward;
        }
      }
    }
  }

  // ---------------------------------------------------------------- one time step
  step(dt: number) {
    this.t += dt;
    // 1. ambulances move (they stop at a red/yellow light like anyone else)
    for (const a of this.ambulances.values()) this.stepAmbulance(a, dt);
    // 2. every junction decides which ambulance (if any) it serves, then runs its lights
    for (const j of this.junctions.values()) this.stepJunction(j, dt);
    // 3. civilian traffic
    if (this.cars.length) this.stepCars(dt);
  }

  private stepAmbulance(a: Ambulance, dt: number) {
    if (a.arrived) { a.v = 0; return; }
    const cruise = a.targetKmh / 3.6;
    let vTarget = cruise;
    const nx = a.next();
    if (nx) {
      const j = this.junctions.get(nx.jid);
      const stopAt = nx.s - STOP_LINE_M;
      const gap = stopAt - a.s;
      if (j && gap > -1 && gap < 120) {
        const lamp = j.ctrl.lamp(nx.approachArm);
        if (lamp !== "G") {
          const canStop = lamp === "R" || gap > (a.v * a.v) / (2 * 5);
          if (canStop) vTarget = Math.min(vTarget, Math.sqrt(2 * 4.0 * Math.max(0, gap)));
        }
      }
    }
    const acc = vTarget > a.v ? 2.5 : -7;
    a.v = Math.max(0, acc > 0 ? Math.min(vTarget, a.v + acc * dt) : Math.max(vTarget, a.v + acc * dt));
    if (vTarget < 0.3 && nx && nx.s - STOP_LINE_M - a.s < 0.5) a.v = 0;
    const stopped = a.v < 0.5 && !!nx && nx.s - a.s < 40;
    if (stopped) a.waitedS += dt;
    a.markStopped(stopped);
    a.s += a.v * dt;
    for (const rj of a.routeJunctions) {
      if (!rj.passed && a.s >= rj.s) {
        rj.passed = true;
        const j = this.junctions.get(rj.jid);
        rj.greenOnArrival = j ? j.ctrl.lamp(rj.approachArm) === "G" : false;
        this.kpi.arrivals++;
        if (rj.greenOnArrival) this.kpi.greenOnArrival++;
        else this.log("warn", `${a.id} entered ${rj.jid} on ${j?.ctrl.lamp(rj.approachArm)}`);
      }
    }
    if (a.s >= a.route.length) {
      a.s = a.route.length;
      a.arrived = true;
      a.siren = false;
      a.v = 0;
      this.log("info", `${a.id} reached its destination (waited ${a.waitedS.toFixed(1)} s at lights in total)`);
    }
  }

  private stepJunction(j: Junction, dt: number) {
    type Cand = { a: Ambulance; rj: RouteJunction; d: number; score: number };
    const cands: Cand[] = [];
    for (const a of this.ambulances.values()) {
      if (!a.siren || a.arrived) continue;
      const until = j.lockout.get(a.id);
      if (until !== undefined && this.t < until) continue;
      const rj = a.routeJunctions.find((r) => r.jid === j.id);
      if (rj) {
        const d = rj.s - a.s;
        if (d <= DETECT_M && d > -PASS_M) {
          const eta = Math.max(0, d) / Math.max(a.v, 3);
          cands.push({ a, rj, d, score: eta - SEVERITY_BONUS_S * (a.severity - 1) });
        }
      } else if (haversineM(a.pos, [j.lat, j.lng]) <= DETECT_M) {
        if (!j.offRouteNear.has(a.id)) {
          j.offRouteNear.add(a.id);
          this.kpi.falseAlertsFiltered++;
          this.log("info", `${j.id} ignores ${a.id}: within ${DETECT_M} m but not on its route`);
        }
      } else {
        j.offRouteNear.delete(a.id);
      }
    }
    // whoever is being served keeps the junction until it has passed
    const prevServed = j.served;
    let chosen = cands.find((c) => c.a.id === j.served) ?? null;
    if (!chosen && cands.length) {
      chosen = cands.reduce((b, c) => (c.score < b.score ? c : b));
      j.served = chosen.a.id;
      this.kpi.preemptions++;
      if (prevServed) this.log("info", `${j.id}: ${prevServed} has passed`);
      this.log("preempt", `${j.id} PREEMPT for ${chosen.a.id} at ${Math.round(chosen.d)} m: arm ${j.arms[chosen.rj.approachArm].label} (${chosen.rj.turn}, Δθ ${chosen.rj.dTheta.toFixed(0)}°)`);
    }
    if (!chosen && j.served) {
      this.log("info", `${j.id}: ${j.served} has passed - normal cycle resumes`);
      j.served = null;
    }
    j.queue = cands.filter((c) => c !== chosen).sort((x, y) => x.score - y.score).map((c) => c.a.id);
    j.waiting = Object.fromEntries(cands.map((c) => [c.a.id, Math.round(c.d)]));
    let req = chosen ? chosen.rj.approachArm : null;
    if (chosen && j.ctrl.mode === "PREEMPT" && j.ctrl.holdT > TIMING.MAX_HOLD_S) {
      j.lockout.set(chosen.a.id, this.t + TIMING.LOCKOUT_S);
      this.log("warn", `${j.id}: held ${TIMING.MAX_HOLD_S} s for ${chosen.a.id} - releasing to cross traffic for ${TIMING.LOCKOUT_S} s`);
      j.served = null;
      req = null;
    }
    j.ctrl.step(dt, req);
    // safety invariant: never two greens; never green -> red without yellow
    const lamps = j.arms.map((a) => j.ctrl.lamp(a.idx));
    const prev = this.lastLamps.get(j.id);
    if (lamps.filter((l) => l === "G").length > 1) this.kpi.conflicts++;
    if (prev) for (let i = 0; i < lamps.length; i++) if (prev[i] === "G" && lamps[i] === "R") this.kpi.conflicts++;
    this.lastLamps.set(j.id, lamps);
  }

  // ---------------------------------------------------------------- read-out
  junctionState(j: Junction) {
    return {
      id: j.id,
      name: j.name,
      lat: j.lat,
      lng: j.lng,
      topology: j.topology,
      mode: j.ctrl.mode,
      phase: j.ctrl.phase,
      greenArm: j.arms[j.ctrl.greenArm]?.label,
      countdownS: isFinite(j.ctrl.remaining()) ? Math.round(j.ctrl.remaining() * 10) / 10 : null,
      served: j.served,
      queue: j.queue,
      ambulancesWithin200m: j.waiting,
      arms: j.arms.map((a) => ({
        arm: a.label,
        road: a.name,
        bearing: Math.round(a.bearing),
        lamp: j.ctrl.lamp(a.idx),
        gpio: { red: a.gpio[0], yellow: a.gpio[1], green: a.gpio[2] },
        queuedCars: a.queue,
      })),
    };
  }

  ambulanceState(a: Ambulance) {
    const nx = a.next();
    const [lat, lng] = a.pos;
    return {
      id: a.id,
      lat, lng,
      speedKmh: Math.round(a.v * 36) / 10,
      headingDeg: Math.round(a.heading),
      severity: a.severity,
      siren: a.siren,
      arrived: a.arrived,
      progressM: Math.round(a.s),
      routeM: Math.round(a.route.length),
      waitedS: Math.round(a.waitedS * 10) / 10,
      nextJunction: nx ? { id: nx.jid, distanceM: Math.round(nx.s - a.s), turn: nx.turn, dThetaDeg: Math.round(nx.dTheta) } : null,
      junctions: a.routeJunctions.map((r) => ({ id: r.jid, turn: r.turn, dThetaDeg: Math.round(r.dTheta), atM: Math.round(r.s), greenOnArrival: r.greenOnArrival ?? null })),
    };
  }

  snapshot() {
    const stopped = this.cars.filter((c) => c.stopped).length;
    return {
      t: Math.round(this.t * 10) / 10,
      network: this.graph.label,
      junctions: [...this.junctions.values()].map((j) => this.junctionState(j)),
      ambulances: [...this.ambulances.values()].map((a) => this.ambulanceState(a)),
      traffic: { density: this.density, cars: this.cars.length, stopped, congestionPct: this.cars.length ? Math.round((100 * stopped) / this.cars.length) : 0 },
      kpi: { ...this.kpi },
    };
  }
}

export { bearingDeg };
