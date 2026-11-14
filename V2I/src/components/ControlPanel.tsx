"use client";
// Left column in map mode: road network, dispatch (start -> hospital), traffic lights, traffic, scenarios.
import { useState } from "react";
import type { LL } from "@/lib/geo";
import { SCENARIOS, type ScenarioResult } from "@/lib/scenarios";
import { DENSITY_COUNT, type Density, type V2IEngine } from "@/lib/v2iPreemptionEngine";
import type { PlaceMode } from "./InteractiveV2IMap";

export interface DispatchOptions { speedKmh: number; severity: number; useOrs: boolean; rsuOnRoute: boolean }

interface Props {
  engine: V2IEngine;
  network: "demo" | "osm";
  setNetwork: (n: "demo" | "osm") => void;
  viewOk: boolean;
  onLoadRoads: () => void;
  roadsBusy: boolean;
  roadsMsg: string;
  onGoTo: (p: LL) => void;
  placing: PlaceMode;
  setPlacing: (m: PlaceMode) => void;
  pins: { start: LL | null; dest: LL | null };
  opts: DispatchOptions;
  setOpts: (o: DispatchOptions) => void;
  orsAvailable: boolean;
  onDispatch: () => void;
  dispatchBusy: boolean;
  dispatchMsg: string;
  onAutoPlace: () => void;
  onClearLights: () => void;
  lightMsg: string;
  setDensity: (d: Density) => void;
  onRunScenario: (id: number) => void;
  scenarioMsg: string;
  onVerifyAll: () => void;
  verifying: boolean;
  results: ScenarioResult[];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-rule px-4 py-4">
      <h2 className="mb-2.5 text-[15px] font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

const btn = "rounded border border-rule bg-sheet px-2.5 py-1.5 text-sm font-semibold hover:bg-paper disabled:cursor-not-allowed disabled:opacity-40";
const btnOn = "rounded border border-beacon bg-beacon-soft px-2.5 py-1.5 text-sm font-semibold text-beacon";
const fmt = (p: LL) => `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;

export default function ControlPanel(p: Props) {
  const [goto, setGoto] = useState("12.9716, 77.5946");
  const toggle = (m: Exclude<PlaceMode, null>) => p.setPlacing(p.placing === m ? null : m);
  const parsed = (() => {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(goto);
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? ([lat, lng] as LL) : null;
  })();

  return (
    <div className="text-sm">
      <Section title="Road network">
        <div className="flex rounded-md border border-rule p-0.5" role="radiogroup" aria-label="Road network">
          {(["demo", "osm"] as const).map((n) => (
            <button key={n} role="radio" aria-checked={p.network === n} onClick={() => p.setNetwork(n)}
              className={`flex-1 rounded px-2 py-1.5 font-semibold ${p.network === n ? "bg-ink text-white" : "text-dim hover:text-ink"}`}>
              {n === "demo" ? "Demo grid" : "OpenStreetMap"}
            </button>
          ))}
        </div>
        {p.network === "demo" ? (
          <p className="mt-2 text-xs text-dim">A synthetic 6 × 5 street grid with a five-arm junction. Works offline; the scenarios are tuned on it.</p>
        ) : (
          <div className="mt-3 space-y-2">
            <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (parsed) p.onGoTo(parsed); }}>
              <label className="sr-only" htmlFor="goto">Latitude, longitude</label>
              <input id="goto" value={goto} onChange={(e) => setGoto(e.target.value)} className="min-w-0 flex-1 rounded border border-rule bg-sheet px-2 py-1.5 font-mono text-[13px]" placeholder="lat, lng" />
              <button className={btn} disabled={!parsed}>Go</button>
            </form>
            <button className={`${btn} w-full`} disabled={!p.viewOk || p.roadsBusy} onClick={p.onLoadRoads}>
              {p.roadsBusy ? "Loading roads (up to a minute)…" : "Load the roads in view"}
            </button>
            <p className="text-xs text-dim">{p.viewOk ? "Loads drivable OpenStreetMap roads for the area on screen and puts roadside units at mapped traffic signals." : "Zoom in until the view is about 4 km across or less."}</p>
          </div>
        )}
        {p.roadsMsg && <p className="mt-2 text-xs" role="status">{p.roadsMsg}</p>}
      </Section>

      <Section title="Dispatch an ambulance">
        <ol className="space-y-2">
          <li className="flex items-center gap-2">
            <span className="w-4 text-dim">1</span>
            <button className={p.placing === "start" ? btnOn : btn} onClick={() => toggle("start")} aria-pressed={p.placing === "start"}>Set the start</button>
            <span className="truncate font-mono text-[12px] text-dim">{p.pins.start ? fmt(p.pins.start) : "click the map"}</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="w-4 text-dim">2</span>
            <button className={p.placing === "dest" ? btnOn : btn} onClick={() => toggle("dest")} aria-pressed={p.placing === "dest"}>Set the hospital</button>
            <span className="truncate font-mono text-[12px] text-dim">{p.pins.dest ? fmt(p.pins.dest) : "click the map"}</span>
          </li>
          <li className="flex gap-2">
            <span className="w-4 pt-1 text-dim">3</span>
            <div className="flex-1 space-y-2">
              <label className="block">
                <span className="flex justify-between"><span>Cruise speed</span><b>{p.opts.speedKmh} km/h</b></span>
                <input type="range" min={20} max={80} step={5} value={p.opts.speedKmh} onChange={(e) => p.setOpts({ ...p.opts, speedKmh: Number(e.target.value) })} className="w-full accent-[#1F4FD8]" />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span>Severity</span>
                <select className="rounded border border-rule bg-sheet px-2 py-1" value={p.opts.severity} onChange={(e) => p.setOpts({ ...p.opts, severity: Number(e.target.value) })}>
                  <option value={1}>1: routine transfer</option>
                  <option value={2}>2: urgent</option>
                  <option value={3}>3: critical</option>
                </select>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={p.opts.useOrs && p.orsAvailable} disabled={!p.orsAvailable} onChange={(e) => p.setOpts({ ...p.opts, useOrs: e.target.checked })} />
                <span>Route with OpenRouteService{!p.orsAvailable && <span className="block text-xs text-dim">Not configured on this server; routing uses the loaded road graph.</span>}</span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={p.opts.rsuOnRoute} onChange={(e) => p.setOpts({ ...p.opts, rsuOnRoute: e.target.checked })} />
                <span>Put a roadside unit at every junction on the route</span>
              </label>
              <button className="w-full rounded bg-beacon px-3 py-2 font-semibold text-white disabled:opacity-40" disabled={!p.pins.start || !p.pins.dest || p.dispatchBusy} onClick={p.onDispatch}>
                {p.dispatchBusy ? "Finding the route…" : "Dispatch"}
              </button>
            </div>
          </li>
        </ol>
        {p.dispatchMsg && <p className="mt-2 text-xs" role="status">{p.dispatchMsg}</p>}
      </Section>

      <Section title="Traffic lights">
        <div className="flex flex-wrap gap-1.5">
          <button className={p.placing === "light" ? btnOn : btn} onClick={() => toggle("light")} aria-pressed={p.placing === "light"}>Drop a traffic light</button>
          <button className={btn} onClick={p.onAutoPlace}>{p.network === "osm" ? "At mapped signals" : "Auto-place"}</button>
          <button className={btn} onClick={p.onClearLights} disabled={p.engine.junctions.size === 0}>Remove all</button>
        </div>
        <p className="mt-2 text-xs text-dim">
          {p.placing === "light" ? "Click near a junction: the light snaps to it (dashed circles) and is classed as T, 4-way or multi-arm." : `${p.engine.junctions.size} roadside units placed.`}
        </p>
        {p.lightMsg && <p className="mt-1 text-xs" role="status">{p.lightMsg}</p>}
      </Section>

      <Section title="Civilian traffic">
        <div className="flex rounded-md border border-rule p-0.5" role="radiogroup" aria-label="Traffic density">
          {(Object.keys(DENSITY_COUNT) as Density[]).map((d) => (
            <button key={d} role="radio" aria-checked={p.engine.density === d} onClick={() => p.setDensity(d)}
              className={`flex-1 rounded px-1 py-1.5 font-semibold ${p.engine.density === d ? "bg-ink text-white" : "text-dim hover:text-ink"}`}>
              {d === "off" ? "Off" : `${d[0].toUpperCase()}${d.slice(1)} ${DENSITY_COUNT[d]}`}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Scenarios">
        <ul className="space-y-1">
          {SCENARIOS.map((s) => {
            const r = p.results.find((x) => x.id === s.id);
            return (
              <li key={s.id} className="flex items-center gap-2">
                <button className={`${btn} shrink-0 px-2 py-1`} onClick={() => p.onRunScenario(s.id)} title={s.about}>Run</button>
                <span className="min-w-0 flex-1 truncate" title={s.about}>{s.name}</span>
                {r && <span className={`text-xs font-semibold ${r.passed ? "text-sig-g" : "text-sig-r"}`}>{r.passed ? "passed" : "failed"}</span>}
              </li>
            );
          })}
        </ul>
        <button className={`${btn} mt-3 w-full`} onClick={p.onVerifyAll} disabled={p.verifying}>{p.verifying ? "Verifying…" : "Verify S1–S7 on this network"}</button>
        {p.scenarioMsg && <p className="mt-2 text-xs" role="status">{p.scenarioMsg}</p>}
        {p.results.length > 0 && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer font-semibold">Checks</summary>
            {p.results.map((r) => (
              <div key={r.id} className="mt-2">
                <div className="font-semibold">{r.name}: {r.passed ? "passed" : "failed"} ({r.simulatedS.toFixed(0)} s simulated)</div>
                <ul className="ml-3 list-disc">
                  {r.checks.map((c, i) => <li key={i} className={c.ok ? "" : "text-sig-r"}>{c.name}: {c.detail}</li>)}
                </ul>
              </div>
            ))}
          </details>
        )}
      </Section>
    </div>
  );
}
