"use client";
// Right column: the selected junction, the ambulances and the event log.
import type { V2IEngine } from "@/lib/v2iPreemptionEngine";
import { ambColor } from "./colors";

interface Props {
  engine: V2IEngine;
  selectedJunction: string | null;
  setSelectedJunction: (id: string | null) => void;
  selectedAmbulance: string | null;
  setSelectedAmbulance: (id: string | null) => void;
  onRemoveJunction: (id: string) => void;
  onRemoveAmbulance: (id: string) => void;
}

const LAMP_CLS = { R: "lamp-on-r", Y: "lamp-on-y", G: "lamp-on-g" } as const;

export default function SidePanel(p: Props) {
  const { engine } = p;
  const j = p.selectedJunction ? engine.junctions.get(p.selectedJunction) ?? null : null;
  const ambs = [...engine.ambulances.values()];
  const events = engine.events.slice(-80).reverse();
  return (
    <div className="text-sm">
      <section className="border-b border-rule px-4 py-4" aria-labelledby="j-title">
        <h2 id="j-title" className="mb-2 text-[15px] font-extrabold">{j ? `${j.id}: ${j.name}` : "Junction"}</h2>
        {!j ? (
          <p className="text-dim">Click a roadside unit on the map to see its lights.</p>
        ) : (
          <>
            <p className="text-dim">{j.topology}, {j.arms.length} arms. {j.ctrl.mode === "PREEMPT" ? <b className="text-beacon">Pre-empted for {j.served}.</b> : j.ctrl.mode === "RECOVER" ? "Recovering to the normal cycle." : "Normal cycle."}</p>
            <table className="mt-2 w-full">
              <thead>
                <tr className="text-left text-xs text-dim">
                  <th className="pb-1 font-normal">Arm</th>
                  <th className="pb-1 font-normal">Lamp</th>
                  <th className="pb-1 font-normal">GPIO R/Y/G</th>
                  <th className="pb-1 text-right font-normal">Queue</th>
                </tr>
              </thead>
              <tbody>
                {j.arms.map((a) => {
                  const l = j.ctrl.lamp(a.idx);
                  return (
                    <tr key={a.idx} className={j.served && j.ctrl.preemptArm === a.idx ? "font-semibold text-beacon" : ""}>
                      <td className="py-0.5" title={a.name || undefined}>{a.label} <span className="text-xs text-dim">{a.bearing.toFixed(0)}°</span></td>
                      <td><span className={`inline-block h-3 w-3 rounded-full align-middle ${LAMP_CLS[l]}`} aria-label={l === "G" ? "green" : l === "Y" ? "yellow" : "red"} /></td>
                      <td className="font-mono text-[12px]">{a.gpio.join("/")}</td>
                      <td className="text-right">{a.queue}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-dim">
              {j.ctrl.phase.replace("_", "-").toLowerCase()}, {Number.isFinite(j.ctrl.remaining()) ? `${j.ctrl.remaining().toFixed(1)} s left` : "held while the ambulance comes through"}
              {j.queue.length ? `. Waiting: ${j.queue.join(", ")}` : ""}
            </p>
            <div className="mt-2 flex gap-1.5">
              <button className="rounded border border-rule px-2 py-1 text-xs font-semibold hover:bg-paper" onClick={() => p.onRemoveJunction(j.id)}>Remove this light</button>
              <button className="rounded border border-rule px-2 py-1 text-xs font-semibold hover:bg-paper" onClick={() => p.setSelectedJunction(null)}>Close</button>
            </div>
          </>
        )}
      </section>

      <section className="border-b border-rule px-4 py-4" aria-labelledby="a-title">
        <h2 id="a-title" className="mb-2 text-[15px] font-extrabold">Ambulances</h2>
        {ambs.length === 0 ? (
          <p className="text-dim">None yet. Set a start and a hospital, then dispatch.</p>
        ) : (
          <ul className="space-y-2">
            {ambs.map((a) => {
              const nx = a.next();
              const pct = Math.round((100 * a.s) / Math.max(1, a.route.length));
              const sel = a.id === p.selectedAmbulance;
              return (
                <li key={a.id}>
                  <button className={`w-full rounded-md border p-2 text-left ${sel ? "border-beacon bg-beacon-soft" : "border-rule bg-sheet hover:bg-paper"}`} onClick={() => p.setSelectedAmbulance(sel ? null : a.id)} aria-pressed={sel}>
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold" style={{ color: ambColor(a.num) }}>{a.id}</span>
                      <span className="text-xs text-dim">{a.arrived ? "arrived" : `${(a.v * 3.6).toFixed(0)} km/h, severity ${a.severity}`}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded bg-rule"><div className="h-1.5 rounded" style={{ width: `${pct}%`, background: ambColor(a.num) }} /></div>
                    <div className="mt-1 text-xs text-dim">
                      {a.arrived ? `Waited ${a.waitedS.toFixed(1)} s at lights, ${a.stops} stops` : nx ? `${nx.jid} in ${Math.max(0, Math.round(nx.s - a.s))} m, ${nx.turn.toLowerCase().replace("_", "-")}` : "No roadside units ahead"}
                    </div>
                  </button>
                  {sel && <button className="mt-1 text-xs text-dim underline" onClick={() => p.onRemoveAmbulance(a.id)}>Remove {a.id}</button>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="px-4 py-4" aria-labelledby="log-title">
        <h2 id="log-title" className="mb-2 text-[15px] font-extrabold">Events</h2>
        <ol className="max-h-[38vh] space-y-1 overflow-auto font-mono text-[12px] leading-snug" aria-live="off">
          {events.map((e, i) => (
            <li key={`${e.t}-${i}`} className={e.level === "preempt" ? "text-beacon" : e.level === "warn" || e.level === "error" ? "text-sig-r" : "text-dim"}>
              <span className="text-dim">{e.t.toFixed(1)}s </span>{e.msg}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
