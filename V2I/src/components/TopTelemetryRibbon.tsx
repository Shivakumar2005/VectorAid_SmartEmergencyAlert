"use client";
// The bar across the top: what the network is doing right now, the mode switch and the clock.
import type { V2IEngine } from "@/lib/v2iPreemptionEngine";

export type ViewMode = "map" | "twin";

interface Props {
  engine: V2IEngine;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  running: boolean;
  setRunning: (r: boolean) => void;
  speed: number;
  setSpeed: (s: number) => void;
  server: { ors: boolean; telemetry: boolean } | null;
  boards: { tx: boolean; rsu: boolean };
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className={`text-lg font-extrabold leading-none ${warn ? "text-sig-r" : ""}`}>{value}</div>
      <div className="mt-1 truncate text-[11px] text-dim">{label}</div>
    </div>
  );
}

export default function TopTelemetryRibbon(p: Props) {
  const { engine } = p;
  const k = engine.kpi;
  const stopped = engine.cars.filter((c) => c.stopped).length;
  const active = [...engine.ambulances.values()].filter((a) => !a.arrived).length;
  const t = Math.floor(engine.t);
  const clock = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-rule bg-sheet px-4 py-2.5">
      <div className="mr-2">
        <h1 className="text-[17px] font-extrabold leading-tight">Ambulance signal pre-emption</h1>
        <p className="text-xs text-dim">{engine.graph.label}</p>
      </div>

      <div className="grid grid-cols-3 gap-x-5 gap-y-2 sm:grid-cols-6" aria-label="Network status">
        <Stat label="Sim time" value={clock} />
        <Stat label="Ambulances on the road" value={String(active)} />
        <Stat label="Pre-emptions" value={String(k.preemptions)} />
        <Stat label="Green on arrival" value={k.arrivals ? `${k.greenOnArrival}/${k.arrivals}` : "–"} warn={k.arrivals > 0 && k.greenOnArrival < k.arrivals} />
        <Stat label="Off-route alerts ignored" value={String(k.falseAlertsFiltered)} />
        <Stat label="Conflicting greens" value={String(k.conflicts)} warn={k.conflicts > 0} />
      </div>
      <div className="hidden text-xs text-dim lg:block">
        {engine.cars.length ? `${engine.cars.length} cars, ${Math.round((100 * stopped) / engine.cars.length)}% queued` : "No civilian traffic"}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1" role="group" aria-label="Simulation clock">
          <button className="rounded border border-rule px-3 py-1.5 text-sm font-semibold hover:bg-paper" onClick={() => p.setRunning(!p.running)} aria-pressed={!p.running}>
            {p.running ? "Pause" : "Resume"}
          </button>
          <select aria-label="Simulation speed" className="rounded border border-rule bg-sheet px-2 py-1.5 text-sm" value={p.speed} onChange={(e) => p.setSpeed(Number(e.target.value))}>
            {[0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}× speed</option>)}
          </select>
        </div>
        <div className="flex rounded-md border border-rule p-0.5" role="tablist" aria-label="View">
          {(["map", "twin"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={p.view === v} onClick={() => p.setView(v)}
              className={`rounded px-3 py-1.5 text-sm font-semibold ${p.view === v ? "bg-ink text-white" : "text-dim hover:text-ink"}`}>
              {v === "map" ? "Map simulation" : "Hardware twin"}
            </button>
          ))}
        </div>
        <div className="flex flex-col text-[11px] leading-4 text-dim" aria-label="Connections">
          <span>Routing: {p.server ? (p.server.ors ? "OpenRouteService" : "road graph") : "…"}</span>
          <span>Boards: {p.boards.rsu ? "RSU" : "–"} {p.boards.tx ? "TX" : ""}</span>
        </div>
      </div>
    </header>
  );
}
