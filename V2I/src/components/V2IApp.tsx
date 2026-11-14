"use client";
// The whole application. Mode 1 (map simulation) and mode 2 (hardware twin) share one running
// engine, one selection and one USB bridge, so switching modes never loses state.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Polyline, type LL } from "@/lib/geo";
import { RoadGraph, demoGrid, graphFromOverpass, type OverpassElement } from "@/lib/roadGraph";
import { runScenarioVerification, setupScenario, type ScenarioResult } from "@/lib/scenarios";
import type { V2IEngine } from "@/lib/v2iPreemptionEngine";
import ControlPanel, { type DispatchOptions } from "./ControlPanel";
import type { PlaceMode } from "./InteractiveV2IMap";
import LiveHardwareWebsiteView from "./LiveHardwareWebsiteView";
import SidePanel from "./SidePanel";
import TopTelemetryRibbon, { type ViewMode } from "./TopTelemetryRibbon";
import { useSimulation } from "./useSimulation";
import WebSerialHardwareBridge, { useHardwareBridge, type LinkMode } from "./WebSerialHardwareBridge";

const InteractiveV2IMap = dynamic(() => import("./InteractiveV2IMap"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-dim">Loading the map…</div>,
});

interface ServerConfig { ors: boolean; telemetry: boolean; store: string; tileProxy: boolean }

const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAX_BOX_DEG = 0.04;
const ON_ROUTE_RSU_M = 12;
const SNAP_M = 150;

/** A box (s, w, n, e) around some points: at least 2.4 km across, 700 m margin, at most MAX_BOX_DEG. */
function boxAround(pts: LL[]): [number, number, number, number] | null {
  const lat = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const mLat = 1 / 111320, mLng = 1 / (111320 * Math.cos((lat * Math.PI) / 180));
  let s = Math.min(...pts.map((p) => p[0])) - 700 * mLat, n = Math.max(...pts.map((p) => p[0])) + 700 * mLat;
  let w = Math.min(...pts.map((p) => p[1])) - 700 * mLng, e = Math.max(...pts.map((p) => p[1])) + 700 * mLng;
  const grow = (lo: number, hi: number, min: number): [number, number] => (hi - lo >= min ? [lo, hi] : [(lo + hi) / 2 - min / 2, (lo + hi) / 2 + min / 2]);
  [s, n] = grow(s, n, 2400 * mLat);
  [w, e] = grow(w, e, 2400 * mLng);
  const margin = 0.0005; // the server rounds outwards to 3 decimals
  if (n - s > MAX_BOX_DEG - 2 * margin || e - w > MAX_BOX_DEG - 2 * margin) return null;
  return [s, w, n, e];
}

/** Roadside units at every 3-5 arm junction that a route passes through. */
function placeAlongRoute(engine: V2IEngine, pts: LL[]): number {
  const line = new Polyline(pts);
  let added = 0;
  for (const nd of engine.graph.nodes.values()) {
    const deg = engine.graph.degree(nd.id);
    if (deg < 3 || deg > 5) continue;
    const pr = line.project([nd.lat, nd.lng]);
    if (pr.dist > ON_ROUTE_RSU_M || pr.s < 5 || pr.s > line.length - 5) continue;
    if ([...engine.junctions.values()].some((j) => j.nodeId === nd.id)) continue;
    if (engine.addJunctionAt([nd.lat, nd.lng]).ok) added++;
  }
  return added;
}

export default function V2IApp() {
  const sim = useSimulation();
  const { engine } = sim;
  const [mounted, setMounted] = useState(false);
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [view, setView] = useState<ViewMode>("map");
  const [network, setNetworkState] = useState<"demo" | "osm">("demo");
  const [placing, setPlacing] = useState<PlaceMode>(null);
  const [pins, setPins] = useState<{ start: LL | null; dest: LL | null }>({ start: null, dest: null });
  const [selJ, setSelJ] = useState<string | null>(null);
  const [selA, setSelA] = useState<string | null>(null);
  const [opts, setOpts] = useState<DispatchOptions>({ speedKmh: 45, severity: 2, useOrs: true, rsuOnRoute: true });
  const [viewBox, setViewBox] = useState<{ bbox: [number, number, number, number]; zoom: number } | null>(null);
  const [flyTo, setFlyTo] = useState<{ p: LL; zoom: number; k: number } | null>(null);
  const [roadsBusy, setRoadsBusy] = useState(false);
  const [roadsMsg, setRoadsMsg] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchMsg, setDispatchMsg] = useState("");
  const [lightMsg, setLightMsg] = useState("");
  const [scenarioMsg, setScenarioMsg] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [linkMode, setLinkMode] = useState<LinkMode>("one");
  const [rsuJ, setRsuJ] = useState<string | null>(null);
  const [txA, setTxA] = useState<string | null>(null);
  const bridge = useHardwareBridge(engine, rsuJ, txA, linkMode);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    fetch("/api/v2i/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: ServerConfig | null) => setServer(c ?? { ors: false, telemetry: false, store: "memory", tileProxy: false }))
      .catch(() => setServer({ ors: false, telemetry: false, store: "memory", tileProxy: false }));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPlacing(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tileUrl = network === "osm" ? (server?.tileProxy ? "/api/tiles/{z}/{x}/{y}" : OSM_TILES) : null;
  const viewOk = !!viewBox && viewBox.bbox[2] - viewBox.bbox[0] <= MAX_BOX_DEG && viewBox.bbox[3] - viewBox.bbox[1] <= MAX_BOX_DEG;

  const clearSelections = () => { setSelJ(null); setSelA(null); setPins({ start: null, dest: null }); setRsuJ(null); setTxA(null); };

  const setNetwork = useCallback((n: "demo" | "osm") => {
    if (n === network) return;
    setNetworkState(n);
    clearSelections();
    setResults([]);
    setRoadsMsg("");
    if (n === "demo") sim.replaceGraph(demoGrid());
    else {
      sim.replaceGraph(new RoadGraph("osm", "OpenStreetMap: no roads loaded yet"), false);
      setFlyTo({ p: [12.9716, 77.5946], zoom: 16, k: Date.now() });
      setRoadsMsg("Click \"Set the start\" and then your start street: the roads around it load by themselves. Or pan, zoom in and use \"Load the roads in view\".");
    }
  }, [network, sim]);

  /** Loads OpenStreetMap roads for a box and swaps them in. Returns the new graph, or an error text. */
  const loadRoadsBox = useCallback(async (box: [number, number, number, number], keepPins: boolean): Promise<RoadGraph | string> => {
    const [s, w, n, e] = box;
    // round outwards to 3 decimals so the same area hits the CDN cache
    const q = { s: Math.floor(s * 1000) / 1000, w: Math.floor(w * 1000) / 1000, n: Math.ceil(n * 1000) / 1000, e: Math.ceil(e * 1000) / 1000 };
    setRoadsBusy(true);
    setRoadsMsg("");
    try {
      const r = await fetch(`/api/v2i/roads?s=${q.s}&w=${q.w}&n=${q.n}&e=${q.e}`);
      const data = (await r.json().catch(() => ({}))) as { elements?: OverpassElement[]; error?: string; server?: string };
      if (!r.ok || !data.elements) throw new Error(data.error ?? `server answered HTTP ${r.status}`);
      const g = graphFromOverpass(data.elements, "OpenStreetMap roads, © OpenStreetMap contributors");
      if (g.nodes.size < 2) throw new Error("no drivable roads in this area");
      const e2 = sim.replaceGraph(g);
      setSelJ(null); setSelA(null); setRsuJ(null); setTxA(null);
      if (!keepPins) setPins({ start: null, dest: null });
      setResults([]);
      setRoadsMsg(`Loaded ${g.edges.length} road segments${data.server ? ` from ${data.server}` : ""}. ${e2.junctions.size} roadside units placed at mapped traffic signals.`);
      return g;
    } catch (err) {
      const m = `Could not load roads: ${err instanceof Error ? err.message : String(err)}`;
      setRoadsMsg(m);
      return m;
    } finally {
      setRoadsBusy(false);
    }
  }, [sim]);

  const loadRoads = useCallback(async () => {
    if (viewBox) await loadRoadsBox(viewBox.bbox, false);
  }, [viewBox, loadRoadsBox]);

  const onMapClick = useCallback(async (p: LL) => {
    if (placing === "start" || placing === "dest") {
      const which = placing;
      const place = (g: RoadGraph): boolean => {
        const snap = g.snap(p);
        if (!snap || snap.dist > SNAP_M) return false;
        setPins((x) => ({ ...x, [which]: snap.point }));
        setDispatchMsg("");
        setNotice(null);
        setPlacing(which === "start" && !pins.dest ? "dest" : null);
        return true;
      };
      if (place(engine.graph)) return;
      if (network !== "osm") { setNotice({ text: `That point is more than ${SNAP_M} m from any street. Click on a street.`, error: true }); return; }
      if (roadsBusy) return;
      // No roads here yet: load a box around this point (and the other pin, so both are on one network).
      const other = which === "start" ? pins.dest : pins.start;
      const box = boxAround(other ? [p, other] : [p]);
      if (!box) { setNotice({ text: "The start and the hospital are more than about 4 km apart. Pick a closer hospital.", error: true }); return; }
      setNotice({ text: "Loading the streets around this point… (5–60 s)", error: false });
      const g = await loadRoadsBox(box, true);
      if (typeof g === "string") { setNotice({ text: `${g.replace(/\.+$/, "")}. Click the street again to retry.`, error: true }); return; }
      // the other pin moves onto the new network's nearest street
      if (other) {
        const o = g.snap(other);
        setPins((x) => ({ ...x, [which === "start" ? "dest" : "start"]: o && o.dist <= SNAP_M ? o.point : null }));
      }
      if (!place(g)) setNotice({ text: `Roads loaded, but that point is more than ${SNAP_M} m from a drivable street. Click on a street.`, error: true });
    } else if (placing === "light") {
      if (!engine.graph.nodes.size) { setNotice({ text: "Load the roads first (set a start point, or use \"Load the roads in view\").", error: true }); return; }
      const r = engine.addJunctionAt(p);
      setLightMsg(r.ok ? `${r.junction.id}: ${r.junction.topology}, ${r.junction.arms.length} arms (${r.junction.arms.map((a) => a.label).join(" ")}), GPIO ${r.junction.arms.map((a) => a.gpio.join("/")).join(", ")}` : r.error);
      setNotice(r.ok ? null : { text: r.error, error: true });
      if (r.ok) setSelJ(r.junction.id);
    }
  }, [placing, engine, pins, network, roadsBusy, loadRoadsBox]);

  const dispatchAmb = useCallback(async () => {
    if (!pins.start || !pins.dest) return;
    setDispatchBusy(true);
    setDispatchMsg("");
    let pts: LL[] | null = null;
    let via = "the road graph";
    let note = "";
    try {
      if (opts.useOrs && server?.ors) {
        try {
          const r = await fetch("/api/v2i/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start: pins.start, end: pins.dest }) });
          const d = (await r.json()) as { fallback?: boolean; points?: LL[]; reason?: string; error?: string };
          if (r.ok && !d.fallback && d.points?.length) { pts = d.points; via = "OpenRouteService"; }
          else note = ` (${d.reason ?? d.error ?? `OpenRouteService: HTTP ${r.status}`}; used the road graph instead)`;
        } catch {
          note = " (OpenRouteService unreachable; used the road graph instead)";
        }
      }
      if (!pts) {
        const r = engine.graph.route(pins.start, pins.dest);
        if (!r) { setDispatchMsg("No route between these points on the loaded roads (one-way streets or a disconnected area)."); return; }
        pts = r.pts;
      }
      const added = opts.rsuOnRoute ? placeAlongRoute(engine, pts) : 0;
      const d = engine.dispatch({ routePts: pts, speedKmh: opts.speedKmh, severity: opts.severity });
      if (!d.ok) { setDispatchMsg(d.error); return; }
      const a = d.ambulance;
      setSelA(a.id);
      if (!txA) setTxA(a.id);
      setDispatchMsg(`${a.id}: ${(a.route.length / 1000).toFixed(2)} km via ${via}, ${a.routeJunctions.length} roadside units on the route${added ? ` (${added} added)` : ""}${note}.`);
      setPins({ start: null, dest: null });
    } finally {
      setDispatchBusy(false);
    }
  }, [pins, opts, server, engine, txA]);

  const runScenario = useCallback((id: number) => {
    const e = network === "demo" ? sim.reset() : engine;
    const s = setupScenario(e, id, { placeAll: network === "demo" });
    if (network === "osm") for (const a of e.ambulances.values()) placeAlongRoute(e, a.route.pts);
    setPins({ start: null, dest: null });
    setSelJ(s.focusJunction ?? null);
    setSelA(s.ambulances[0] ?? null);
    if (s.ambulances[0]) setTxA(s.ambulances[0]);
    if (s.focusJunction && !rsuJ) setRsuJ(s.focusJunction);
    setScenarioMsg(s.error ? `${s.name}: ${s.error}` : `${s.name}. ${s.description}`);
  }, [network, sim, engine, rsuJ]);

  const verifyAll = useCallback(() => {
    setVerifying(true);
    setResults([]);
    const g = engine.graph;
    let id = 1;
    const next = () => {
      const r = runScenarioVerification(id, g);
      setResults((x) => [...x, r]);
      if (++id <= 7) setTimeout(next, 0);
      else setVerifying(false);
    };
    setTimeout(next, 0);
  }, [engine]);

  const removeJunction = useCallback((id: string) => {
    engine.removeJunction(id);
    if (selJ === id) setSelJ(null);
    if (rsuJ === id) setRsuJ(null);
  }, [engine, selJ, rsuJ]);

  const removeAmbulance = useCallback((id: string) => {
    engine.removeAmbulance(id);
    if (selA === id) setSelA(null);
    if (txA === id) setTxA(null);
  }, [engine, selA, txA]);

  const placingHint = useMemo(() => (placing === "start" ? "Click a street to set the ambulance's start" : placing === "dest" ? "Click a street to set the hospital" : placing === "light" ? "Click a junction to drop a traffic light" : ""), [placing]);
  useEffect(() => {
    if (!notice?.error) return;
    const t = setTimeout(() => setNotice(null), 10_000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!mounted) {
    return <div className="grid h-dvh place-items-center text-dim">Starting the simulation…</div>;
  }

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <TopTelemetryRibbon engine={engine} view={view} setView={setView} running={sim.running} setRunning={sim.setRunning} speed={sim.speed} setSpeed={sim.setSpeed}
        server={server} boards={bridge.connected} />
      <div className="grid flex-1 lg:min-h-0 lg:grid-cols-[300px_minmax(0,1fr)_320px]">
        <aside className="order-2 border-rule bg-sheet lg:order-none lg:overflow-y-auto lg:border-r" aria-label="Controls">
          {view === "map" ? (
            <ControlPanel engine={engine} network={network} setNetwork={setNetwork} viewOk={viewOk} onLoadRoads={() => void loadRoads()} roadsBusy={roadsBusy} roadsMsg={roadsMsg}
              onGoTo={(p) => setFlyTo({ p, zoom: 16, k: Date.now() })} placing={placing} setPlacing={setPlacing} pins={pins} opts={opts} setOpts={setOpts}
              orsAvailable={!!server?.ors} onDispatch={() => void dispatchAmb()} dispatchBusy={dispatchBusy} dispatchMsg={dispatchMsg}
              onAutoPlace={() => { const n = engine.autoPlaceJunctions(12); setLightMsg(n ? `${n} roadside units placed.` : "No more places found (no mapped signals left without a unit)."); }}
              onClearLights={() => { for (const id of [...engine.junctions.keys()]) engine.removeJunction(id); setSelJ(null); setRsuJ(null); setLightMsg("All roadside units removed."); }}
              lightMsg={lightMsg} setDensity={(d) => engine.setDensity(d)} onRunScenario={runScenario} scenarioMsg={scenarioMsg} onVerifyAll={verifyAll} verifying={verifying} results={results} />
          ) : (
            <div className="p-4">
              <WebSerialHardwareBridge bridge={bridge} engine={engine} mode={linkMode} setMode={setLinkMode} rsuJunctionId={rsuJ} setRsuJunctionId={setRsuJ}
                txAmbulanceId={txA} setTxAmbulanceId={setTxA} />
            </div>
          )}
        </aside>

        <main className="relative order-1 h-[62vh] lg:order-none lg:h-auto lg:min-h-0" aria-label={view === "map" ? "Map" : "Hardware twin"}>
          <div className={view === "map" ? "h-full" : "hidden"}>
            <InteractiveV2IMap sim={sim} placing={placing} onMapClick={(p) => void onMapClick(p)} pins={pins} selectedJunction={selJ} onSelectJunction={setSelJ}
              selectedAmbulance={selA} onSelectAmbulance={setSelA} tileUrl={tileUrl} flyTo={flyTo} visible={view === "map"}
              onViewChange={(bbox, zoom) => setViewBox({ bbox, zoom })} />
          </div>
          {view === "map" && (notice || placingHint) && (
            <div className={`pointer-events-none absolute left-1/2 top-3 z-[1000] max-w-[90%] -translate-x-1/2 rounded-md px-3 py-1.5 text-center text-sm font-semibold text-white shadow ${notice?.error ? "bg-sig-r" : "bg-ink"}`} role="status" aria-live="polite">
              {notice ? notice.text : `${placingHint}. Esc to stop.`}
            </div>
          )}
          {view === "twin" && (
            <LiveHardwareWebsiteView engine={engine} tick={sim.tick} ambulanceId={selA} junctionId={selJ} setAmbulanceId={setSelA} setJunctionId={setSelJ}
              bridge={bridge} linkMode={linkMode} rsuBoardJunction={rsuJ} cloudAvailable={!!server?.telemetry} />
          )}
        </main>

        <aside className="order-3 border-t border-rule bg-sheet lg:order-none lg:overflow-y-auto lg:border-l lg:border-t-0" aria-label="Details">
          <SidePanel engine={engine} selectedJunction={selJ} setSelectedJunction={setSelJ} selectedAmbulance={selA} setSelectedAmbulance={setSelA}
            onRemoveJunction={removeJunction} onRemoveAmbulance={removeAmbulance} />
        </aside>
      </div>
    </div>
  );
}
