// The seven demo scenarios. Each one is built from the road graph itself (find a junction of the
// right shape, walk straight streets out of it), so they work on the demo grid and on real
// OpenStreetMap roads alike. runScenarioVerification() runs one headless and checks the rules.

import { LL, Polyline, Turn, wrap180 } from "./geo";
import { RoadEdge, RoadGraph, Topology, demoGrid } from "./roadGraph";
import { Ambulance, DETECT_M, Junction, STOP_LINE_M, TIMING, V2IEngine } from "./v2iPreemptionEngine";

/** Worst-case time to give an arm green: minimum green of the current arm + yellow + all-red. */
const CLEARANCE_S = TIMING.MIN_GREEN_S + TIMING.YELLOW_S + TIMING.ALL_RED_S;

export const SCENARIOS = [
  { id: 1, name: "S1: Normal Cycle", about: "No ambulance: every junction runs its fixed-time cycle with civilian traffic." },
  { id: 2, name: "S2: Single Ambulance", about: "One ambulance straight across the network through several junctions." },
  { id: 3, name: "S3: 4-Way Left Turn", about: "Ambulance turns LEFT at a 4-way crossroad." },
  { id: 4, name: "S4: T-Junction Right Turn", about: "Ambulance turns RIGHT at a 3-way T-junction." },
  { id: 5, name: "S5: 4-Way Straight", about: "Ambulance goes STRAIGHT through a 4-way crossroad." },
  { id: 6, name: "S6: 3 Ambulances Priority", about: "Three ambulances approach one junction from different roads at 180, 120 and 75 m." },
  { id: 7, name: "S7: Multi-Junction Wave", about: "One ambulance through a chain of junctions with a turn: a green wave." },
] as const;

type Step = { edge: RoadEdge; forward: boolean }; // travel direction along an edge

function legal(step: Step) { return step.forward || !step.edge.oneway; }
function geomOf(step: Step): LL[] { return step.forward ? step.edge.geom : [...step.edge.geom].reverse(); }

/** Walk out of `from` along `first`, then keep going as straight as possible until `minLen`. */
function walkOut(g: RoadGraph, from: string, first: RoadEdge, minLen: number): { steps: Step[]; length: number; end: string } {
  const steps: Step[] = [];
  let node = from;
  let edge = first;
  let length = 0;
  const seen = new Set<string>([from]);
  for (let guard = 0; guard < 50; guard++) {
    const forward = edge.u === node;
    steps.push({ edge, forward });
    length += edge.length;
    node = forward ? edge.v : edge.u;
    if (length >= minLen || seen.has(node)) break;
    seen.add(node);
    const inB = g.arms(node).find((a) => a.edgeId === edge.id);
    if (!inB) break;
    const straight = (inB.bearing + 180) % 360;
    const options = g.arms(node).filter((a) => a.edgeId !== edge.id);
    if (!options.length) break;
    const best = options.reduce((b, a) => (Math.abs(wrap180(a.bearing - straight)) < Math.abs(wrap180(b.bearing - straight)) ? a : b));
    if (Math.abs(wrap180(best.bearing - straight)) > 35) break; // no straight continuation
    edge = g.edgeById.get(best.edgeId)!;
  }
  return { steps, length, end: node };
}

/** A route that arrives at junction node `nodeId` via arm `inEdge` and leaves via `outEdge`. */
function routeThrough(g: RoadGraph, nodeId: string, inEdge: RoadEdge, outEdge: RoadEdge, approachM: number, exitM: number):
  { pts: LL[]; approach: number } | null {
  const back = walkOut(g, nodeId, inEdge, approachM);
  const approachSteps = back.steps.map((s) => ({ edge: s.edge, forward: !s.forward })).reverse();
  const exit = walkOut(g, nodeId, outEdge, exitM);
  if (![...approachSteps, ...exit.steps].every(legal)) return null;
  const pts: LL[] = [];
  for (const st of [...approachSteps, ...exit.steps]) for (const p of geomOf(st)) {
    const q = pts[pts.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
  }
  return { pts, approach: back.length };
}

/** Find a junction of `topo` with an approach/exit pair giving `turn`; prefer central ones. */
function findManeuver(g: RoadGraph, topo: Topology[], turn: Turn, approachM: number, exitM: number, avoidDeadEndExit = true) {
  const [[s, w], [n, e]] = g.bounds();
  const centre: LL = [(s + n) / 2, (w + e) / 2];
  const nodes = [...g.nodes.values()]
    .filter((nd) => { const t = g.topology(nd.id); return t !== null && topo.includes(t); })
    .sort((a, b) => Math.hypot(a.lat - centre[0], a.lng - centre[1]) - Math.hypot(b.lat - centre[0], b.lng - centre[1]));
  for (const nd of nodes) {
    const arms = g.arms(nd.id);
    for (const ain of arms)
      for (const aout of arms) {
        if (ain === aout) continue;
        const inBearing = (ain.bearing + 180) % 360;
        const d = wrap180(aout.bearing - inBearing);
        const ok = turn === "STRAIGHT" ? Math.abs(d) <= 30 : turn === "LEFT" ? d < -30 && d > -150 : turn === "RIGHT" ? d > 30 && d < 150 : false;
        if (!ok) continue;
        const r = routeThrough(g, nd.id, g.edgeById.get(ain.edgeId)!, g.edgeById.get(aout.edgeId)!, approachM, exitM);
        if (!r || r.approach < Math.min(approachM, 250)) continue;
        if (avoidDeadEndExit && r.pts.length < 3) continue;
        return { nodeId: nd.id, ...r };
      }
  }
  return null;
}

/** Of all routes that turn `turn` at a 4-way junction, the one passing the most junctions. */
function findBestCorridor(g: RoadGraph, turn: Turn) {
  let best: { nodeId: string; pts: LL[]; approach: number; count: number } | null = null;
  const junctionNodes = [...g.nodes.values()].filter((nd) => g.degree(nd.id) >= 3);
  // on a big OpenStreetMap network, only try the 25 most central crossroads (otherwise this
  // search grows with the square of the network and freezes the browser)
  const [[s, w], [n, e]] = g.bounds();
  const centre: LL = [(s + n) / 2, (w + e) / 2];
  const candidates = [...g.nodes.values()]
    .filter((nd) => g.topology(nd.id) === "4-Way Crossroad")
    .sort((a, b) => Math.hypot(a.lat - centre[0], a.lng - centre[1]) - Math.hypot(b.lat - centre[0], b.lng - centre[1]))
    .slice(0, 25);
  for (const nd of candidates) {
    const arms = g.arms(nd.id);
    for (const ain of arms)
      for (const aout of arms) {
        if (ain === aout) continue;
        const d = wrap180(aout.bearing - (ain.bearing + 180) % 360);
        const ok = turn === "LEFT" ? d < -30 && d > -150 : turn === "RIGHT" ? d > 30 && d < 150 : Math.abs(d) <= 30;
        if (!ok) continue;
        const r = routeThrough(g, nd.id, g.edgeById.get(ain.edgeId)!, g.edgeById.get(aout.edgeId)!, 1500, 1500);
        if (!r) continue;
        const line = new Polyline(r.pts);
        const lats = r.pts.map((p) => p[0]), lngs = r.pts.map((p) => p[1]);
        const [la0, la1, ln0, ln1] = [Math.min(...lats) - 1e-4, Math.max(...lats) + 1e-4, Math.min(...lngs) - 1e-4, Math.max(...lngs) + 1e-4];
        const count = junctionNodes.filter((j) => {
          if (j.lat < la0 || j.lat > la1 || j.lng < ln0 || j.lng > ln1) return false;
          const pr = line.project([j.lat, j.lng]);
          return pr.dist < 5 && pr.s > 5 && pr.s < line.length - 1;
        }).length;
        if (!best || count > best.count) best = { nodeId: nd.id, ...r, count };
      }
  }
  return best;
}

export interface ScenarioSetup {
  id: number;
  name: string;
  description: string;
  focusJunction?: string;
  ambulances: string[];
  error?: string;
}

/** Above this many junctions a network counts as "big": roadside units go only near the scenario. */
const SMALL_NETWORK_JUNCTIONS = 400;
const NEAR_ROUTE_M = 150;

/**
 * Put a scenario into an engine (clears ambulances). Roadside units:
 *  - placeAll true: every 3-5 arm junction (if none are placed yet)
 *  - placeAll false: leave the placed units as they are
 *  - "auto" (default): every junction on a small network such as the demo grid; on a big
 *    OpenStreetMap network only junctions within 150 m of the scenario's routes (a few hundred
 *    instead of thousands, so the browser stays responsive)
 */
export function setupScenario(engine: V2IEngine, id: number, opts: { placeAll?: boolean | "auto"; speedKmh?: number } = {}): ScenarioSetup {
  const g = engine.graph;
  const meta = SCENARIOS.find((s) => s.id === id);
  if (!meta) return { id, name: "?", description: "", ambulances: [], error: "scenario must be 1..7" };
  for (const a of [...engine.ambulances.keys()]) engine.removeAmbulance(a);
  const candidates = [...g.nodes.values()].filter((nd) => g.degree(nd.id) >= 3 && g.degree(nd.id) <= 5);
  const mode = opts.placeAll ?? "auto";
  const placeEverywhere = mode === true || (mode === "auto" && candidates.length <= SMALL_NETWORK_JUNCTIONS);
  if (placeEverywhere && engine.junctions.size === 0) for (const nd of candidates) engine.addJunctionAt([nd.lat, nd.lng]);
  const placeNearRoutes = mode === "auto" && !placeEverywhere;
  const speed = opts.speedKmh ?? 45;
  const jAt = (nodeId: string) => [...engine.junctions.values()].find((j) => j.nodeId === nodeId);
  const out: ScenarioSetup = { id, name: meta.name, description: meta.about, ambulances: [] };
  let focusNode: string | null = null;
  const go = (pts: LL[], startOffsetM: number, num: number, severity = 2) => {
    const r = engine.dispatch({ routePts: pts, num, speedKmh: speed, severity, startOffsetM });
    if (r.ok) out.ambulances.push(r.ambulance.id);
    return r;
  };

  switch (id) {
    case 1:
      break;
    case 2: {
      // straight across: the longest straight walk through the most central 4-way
      const m = findManeuver(g, ["4-Way Crossroad", "Multi-Arm Intersection"], "STRAIGHT", 600, 600);
      if (!m) return { ...out, error: "no straight corridor found" };
      go(m.pts, 0, 101);
      focusNode = m.nodeId;
      break;
    }
    case 3:
    case 4:
    case 5: {
      const spec: Record<number, [Topology[], Turn]> = {
        3: [["4-Way Crossroad"], "LEFT"],
        4: [["3-Way T-Junction"], "RIGHT"],
        5: [["4-Way Crossroad"], "STRAIGHT"],
      };
      const [topo, turn] = spec[id];
      const m = findManeuver(g, topo, turn, 320, 260);
      if (!m) return { ...out, error: `no ${topo.join("/")} with a ${turn} found on this network` };
      go(m.pts, Math.max(0, m.approach - 300), 101);
      focusNode = m.nodeId;
      break;
    }
    case 6: {
      // one 4-way junction, three different approach roads, 180 / 120 / 75 m out
      const nodes = [...g.nodes.values()].filter((nd) => g.topology(nd.id) === "4-Way Crossroad");
      const [[s, w], [n, e]] = g.bounds();
      nodes.sort((a, b) => Math.hypot(a.lat - (s + n) / 2, a.lng - (w + e) / 2) - Math.hypot(b.lat - (s + n) / 2, b.lng - (w + e) / 2));
      let done = false;
      for (const nd of nodes) {
        const arms = g.arms(nd.id);
        const routes: { pts: LL[]; approach: number }[] = [];
        for (let k = 0; k < arms.length && routes.length < 3; k++) {
          const ain = arms[k];
          const aout = arms.find((a) => Math.abs(wrap180(a.bearing - (ain.bearing + 180))) <= 30); // straight on
          if (!aout) continue;
          const r = routeThrough(g, nd.id, g.edgeById.get(ain.edgeId)!, g.edgeById.get(aout.edgeId)!, 200, 200);
          if (r && r.approach >= 180) routes.push(r);
        }
        if (routes.length < 3) continue;
        const dists = [180, 120, 75];
        routes.forEach((r, i) => go(r.pts, r.approach - dists[i], 101 + i));
        focusNode = nd.id;
        done = true;
        break;
      }
      if (!done) return { ...out, error: "no 4-way junction with three usable approaches found" };
      break;
    }
    case 7: {
      // a corridor through several junctions, with a turn in the middle
      const m = findBestCorridor(g, "LEFT");
      if (!m) return { ...out, error: "no corridor found" };
      go(m.pts, 0, 101);
      focusNode = m.nodeId;
      break;
    }
  }
  if (placeNearRoutes) {
    const lines = [...engine.ambulances.values()].map((a) => a.route);
    let picked = candidates;
    if (lines.length) {
      picked = candidates.filter((nd) => lines.some((line) => line.project([nd.lat, nd.lng]).dist <= NEAR_ROUTE_M));
    } else {
      // S1 has no ambulance: the 20 most central junctions
      const [[s, w], [n, e]] = g.bounds();
      picked = [...candidates].sort((a, b) => Math.hypot(a.lat - (s + n) / 2, a.lng - (w + e) / 2) - Math.hypot(b.lat - (s + n) / 2, b.lng - (w + e) / 2)).slice(0, 20);
    }
    for (const nd of picked) if (!jAt(nd.id)) engine.addJunctionAt([nd.lat, nd.lng]);
  }
  if (focusNode) out.focusJunction = jAt(focusNode)?.id;
  if (engine.density === "off") engine.setDensity("medium");
  return out;
}

// ------------------------------------------------------------------ verification
export interface Check { name: string; ok: boolean; detail: string }
export interface ScenarioResult {
  id: number;
  name: string;
  passed: boolean;
  simulatedS: number;
  checks: Check[];
  servedOrder?: string[];
  ambulances: ReturnType<V2IEngine["ambulanceState"]>[];
  kpi: V2IEngine["kpi"];
  events: string[];
}

export function runScenarioVerification(id: number, graph: RoadGraph = demoGrid(), seed = 7): ScenarioResult {
  const engine = new V2IEngine(graph, seed);
  const setup = setupScenario(engine, id);
  const checks: Check[] = [];
  if (setup.error) {
    return { id, name: setup.name, passed: false, simulatedS: 0, checks: [{ name: "setup", ok: false, detail: setup.error }], ambulances: [], kpi: engine.kpi, events: [] };
  }
  const dt = 0.05;
  const limit = id === 1 ? 160 : 400;
  // lamp history per junction, to check the sequence rules ourselves (not only the engine's counter)
  const last = new Map<string, string[]>();
  const allRedSince = new Map<string, number>();
  const sawGreen = new Map<string, Set<number>>();
  let seqViolations = 0;
  const servedOrder: string[] = [];
  let lastServed: string | null = null;
  const focus = setup.focusJunction ? engine.junctions.get(setup.focusJunction) : undefined;
  const offRouteServed: string[] = [];
  const startAt = new Map([...engine.ambulances.values()].map((a) => [a.id, a.s]));
  const stoppedAt = new Map<string, Set<string>>(); // ambulance -> junctions it stopped in front of
  const focusWait = new Map<string, number>(); // ambulance -> seconds stopped in front of the focus junction

  for (let t = 0; t < limit; t += dt) {
    engine.step(dt);
    for (const a of engine.ambulances.values()) {
      const nx = a.next();
      if (a.arrived || !nx || a.v >= 0.5 || nx.s - a.s > 40) continue;
      if (!stoppedAt.has(a.id)) stoppedAt.set(a.id, new Set());
      stoppedAt.get(a.id)!.add(nx.jid);
      if (focus && nx.jid === focus.id) focusWait.set(a.id, (focusWait.get(a.id) ?? 0) + dt);
    }
    for (const j of engine.junctions.values()) {
      const lamps = j.arms.map((a) => j.ctrl.lamp(a.idx));
      const prev = last.get(j.id);
      const greens = lamps.filter((l) => l === "G").length;
      if (greens > 1) seqViolations++;
      if (prev) {
        for (let i = 0; i < lamps.length; i++) {
          if (prev[i] === "G" && lamps[i] === "R") seqViolations++;
          if (prev[i] === "Y" && lamps[i] === "G") seqViolations++;
          if (prev[i] !== "G" && lamps[i] === "G" && engine.t - (allRedSince.get(j.id) ?? -1e9) < 1.95) seqViolations++;
        }
        if (lamps.every((l) => l === "R") && !prev.every((l) => l === "R")) allRedSince.set(j.id, engine.t);
      } else if (lamps.every((l) => l === "R")) allRedSince.set(j.id, engine.t - j.ctrl.t);
      last.set(j.id, lamps);
      if (!sawGreen.has(j.id)) sawGreen.set(j.id, new Set());
      lamps.forEach((l, i) => l === "G" && sawGreen.get(j.id)!.add(i));
      if (j.served) {
        const a = engine.ambulances.get(j.served);
        if (a && !a.routeJunctions.some((r) => r.jid === j.id)) offRouteServed.push(`${j.id}<-${a.id}`);
      }
    }
    if (focus && focus.served && focus.served !== lastServed) {
      const a = engine.ambulances.get(focus.served)!;
      const rj = a.routeJunctions.find((r) => r.jid === focus.id)!;
      if (focus.ctrl.lamp(rj.approachArm) === "G" && !servedOrder.includes(a.id)) {
        servedOrder.push(a.id);
        lastServed = focus.served;
      }
    }
    if (id !== 1 && [...engine.ambulances.values()].every((a) => a.arrived)) break;
  }

  checks.push({ name: "Never two roads green at once; green always ends in yellow; 2 s all-red before any green", ok: seqViolations === 0 && engine.kpi.conflicts === 0, detail: `${seqViolations + engine.kpi.conflicts} violations` });
  checks.push({ name: "Junctions NOT on an ambulance's route never pre-empt for it", ok: offRouteServed.length === 0, detail: offRouteServed.length ? offRouteServed.slice(0, 5).join(", ") : "0 false activations" });
  const ambs = [...engine.ambulances.values()];

  if (id === 1) {
    const missing = [...engine.junctions.values()].filter((j) => j.arms.some((a) => !sawGreen.get(j.id)?.has(a.idx)));
    checks.push({ name: "Every arm of every junction got its green in the normal cycle", ok: missing.length === 0, detail: missing.length ? missing.map((j) => j.id).join(", ") : `${engine.junctions.size} junctions` });
    checks.push({ name: "No pre-emption without an ambulance", ok: engine.kpi.preemptions === 0, detail: `${engine.kpi.preemptions}` });
    checks.push({ name: "Civilian traffic moving", ok: engine.cars.length > 0 && engine.cars.some((c) => !c.stopped), detail: `${engine.cars.length} cars` });
  } else {
    checks.push({ name: "Every ambulance reached its destination", ok: ambs.every((a) => a.arrived), detail: ambs.map((a) => `${a.id} ${a.arrived ? "arrived" : "not arrived"}`).join(", ") });
  }
  if ([2, 3, 4, 5, 7].includes(id)) {
    const a = ambs[0];
    const onRoute = a.routeJunctions;
    // A junction can only be cleared in time if the ambulance is seen at least CLEARANCE_S of
    // driving (plus the stop line) before it: worst case 5 s minimum green + 3 s yellow + 2 s
    // all-red. On dense streets a scenario can start an ambulance closer than that to a junction;
    // no controller could make those green, so they are listed, not counted.
    const v = a.targetKmh / 3.6;
    const needM = CLEARANCE_S * v + STOP_LINE_M;
    const start = startAt.get(a.id) ?? 0;
    const warned = onRoute.filter((r) => Math.min(r.s - start, DETECT_M) >= needM);
    const tooClose = onRoute.filter((r) => !warned.includes(r));
    const green = warned.filter((r) => r.greenOnArrival);
    const stops = [...(stoppedAt.get(a.id) ?? [])].filter((jid) => warned.some((r) => r.jid === jid));
    checks.push({
      name: `Green on arrival at every junction it was detected in time for (≥ ${Math.round(needM)} m ahead)`,
      ok: warned.length > 0 && green.length === warned.length,
      detail: `${green.length}/${warned.length}: ${warned.map((r) => `${r.jid}${r.greenOnArrival ? "" : "(red)"}`).join(" ")}` +
        (tooClose.length ? `; too close to the start to clear: ${tooClose.map((r) => `${r.jid} at ${Math.round(r.s - start)} m`).join(", ")}` : ""),
    });
    checks.push({ name: "Never stopped at a junction it was detected in time for", ok: stops.length === 0, detail: stops.length ? `stopped at ${stops.join(", ")}` : `0 stops (${a.waitedS.toFixed(1)} s waiting in total)` });
    const want: Record<number, Turn> = { 3: "LEFT", 4: "RIGHT", 5: "STRAIGHT" };
    if (want[id]) {
      const rj = onRoute.find((r) => r.jid === setup.focusJunction);
      checks.push({ name: `Turn at ${setup.focusJunction} classified ${want[id]}`, ok: rj?.turn === want[id], detail: rj ? `${rj.turn}, Δθ ${rj.dTheta.toFixed(0)}°` : "junction not on route" });
      const j = engine.junctions.get(setup.focusJunction!);
      const wantTopo = id === 4 ? "3-Way T-Junction" : "4-Way Crossroad";
      checks.push({ name: `${setup.focusJunction} topology is ${wantTopo}`, ok: j?.topology === wantTopo, detail: j?.topology ?? "?" });
    }
    if (id === 2 || id === 7) {
      checks.push({ name: "Several junctions on the route", ok: onRoute.length >= (id === 7 ? 4 : 3), detail: `${onRoute.length}` });
      checks.push({ name: "Nearby junctions off the route were filtered (no false alert)", ok: engine.kpi.falseAlertsFiltered > 0, detail: `${engine.kpi.falseAlertsFiltered} filtered` });
    }
  }
  if (id === 6) {
    const byDistance = [...ambs].sort((x, y) => {
      const rx = x.routeJunctions.find((r) => r.jid === setup.focusJunction)!;
      const ry = y.routeJunctions.find((r) => r.jid === setup.focusJunction)!;
      return (rx.s - (startAt.get(x.id) ?? 0)) - (ry.s - (startAt.get(y.id) ?? 0));
    }).map((a) => a.id);
    checks.push({ name: "Closest ambulance served first, then the next, then the farthest", ok: servedOrder.join(">") === byDistance.join(">"), detail: `served ${servedOrder.join(" > ")}; by distance ${byDistance.join(" > ")}` });
    const waits = byDistance.map((x) => `${x} waited ${(focusWait.get(x) ?? 0).toFixed(1)} s`).join(", ");
    const firstWait = focusWait.get(byDistance[0]) ?? 0;
    checks.push({ name: `The closest ambulance waits at ${setup.focusJunction} no longer than one clearance (${CLEARANCE_S} s)`, ok: firstWait <= CLEARANCE_S, detail: waits });
  }
  const passed = checks.every((c) => c.ok);
  return {
    id, name: setup.name, passed, simulatedS: Math.round(engine.t), checks, servedOrder: id === 6 ? servedOrder : undefined,
    ambulances: ambs.map((a) => engine.ambulanceState(a)), kpi: { ...engine.kpi },
    events: engine.events.filter((e) => e.level !== "info" || /PREEMPT|passed|reached|ignores/.test(e.msg)).slice(-40).map((e) => `${e.t.toFixed(1)}s ${e.msg}`),
  };
}

export type { Ambulance, Junction };
