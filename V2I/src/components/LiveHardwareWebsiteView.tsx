"use client";
// Hardware twin: the ambulance unit (what it transmits, byte by byte), the radio link, and the
// roadside unit (its signal heads and GPIO levels) - from the simulation, side by side with what
// the real boards report over USB, and with units reporting over Wi-Fi to the cloud.
import { useEffect, useState } from "react";
import { cardinal, haversineM } from "@/lib/geo";
import { FIELD_MAP, decodePacket } from "@/lib/rf24PacketCodec";
import type { Lamp, V2IEngine } from "@/lib/v2iPreemptionEngine";
import type { RsuStatus, TxStatus } from "@/lib/webSerial";
import { ambColor } from "./colors";
import PhysicalTrafficSignalHead from "./PhysicalTrafficSignalHead";
import type { HardwareBridge, LinkMode } from "./WebSerialHardwareBridge";

interface Props {
  engine: V2IEngine;
  tick: number;
  ambulanceId: string | null;
  junctionId: string | null;
  setAmbulanceId: (id: string | null) => void;
  setJunctionId: (id: string | null) => void;
  bridge: HardwareBridge;
  linkMode: LinkMode;
  rsuBoardJunction: string | null;
  cloudAvailable: boolean;
}

const FIELD_TINT = ["bg-[#E3E8EE]", "bg-[#D5DCE5]"];

function TurnGlyph({ turn }: { turn: string }) {
  const d: Record<string, string> = {
    STRAIGHT: "M12 21V4M6 10l6-6 6 6",
    LEFT: "M16 21v-8a4 4 0 0 0-4-4H5M10 4 5 9l5 5",
    RIGHT: "M8 21v-8a4 4 0 0 1 4-4h7M14 4l5 5-5 5",
    U_TURN: "M8 21V9a5 5 0 0 1 10 0v4M14 10l4 4 4-4",
  };
  if (!d[turn]) return null;
  return (
    <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d[turn]} />
    </svg>
  );
}

function Readout({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div>
      <div className="text-xs text-dim">{label}</div>
      <div className="text-2xl font-extrabold leading-tight">
        {value}
        {unit && <span className="ml-1 text-sm font-semibold text-dim">{unit}</span>}
      </div>
    </div>
  );
}

function HexInspector({ bytes, compare }: { bytes: Uint8Array; compare?: string | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const fieldOf = (i: number) => FIELD_MAP.findIndex(([o, l]) => i >= o && i < o + l);
  const hf = hover === null ? -1 : fieldOf(hover);
  const cmp = compare && /^[0-9A-F]{64}$/i.test(compare) ? compare.toUpperCase() : null;
  return (
    <div>
      <div className="grid grid-cols-8 gap-1 font-mono text-[13px]" onMouseLeave={() => setHover(null)}>
        {Array.from(bytes, (b, i) => {
          const f = fieldOf(i);
          const hx = b.toString(16).padStart(2, "0").toUpperCase();
          const differs = cmp ? cmp.slice(2 * i, 2 * i + 2) !== hx : false;
          return (
            <button
              type="button"
              key={i}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              title={`byte ${i}: ${FIELD_MAP[f][2]}`}
              className={`rounded px-0.5 py-1 text-center ${f === hf ? "bg-beacon text-white" : FIELD_TINT[f % 2]} ${differs ? "underline decoration-sig-r decoration-2" : ""}`}
            >
              {hx}
            </button>
          );
        })}
      </div>
      <p className="mt-1 h-5 text-xs text-dim">
        {hf >= 0 ? `bytes ${FIELD_MAP[hf][0]}–${FIELD_MAP[hf][0] + FIELD_MAP[hf][1] - 1}: ${FIELD_MAP[hf][2]}` : "Point at a byte to see its field."}
      </p>
    </div>
  );
}

function useCloud(enabled: boolean) {
  const [units, setUnits] = useState<{ deviceId: string; junctionId: string; mode: string; lamps: string; servedAmbId: string | null; receivedAt: number; ambulances: unknown[] }[]>([]);
  const [status, setStatus] = useState("off");
  useEffect(() => {
    if (!enabled) { setStatus("off"); return; }
    const es = new EventSource("/api/v2i/stream");
    setStatus("connecting");
    es.addEventListener("hello", () => setStatus("live"));
    es.addEventListener("rsu", (ev) => { try { setUnits(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore a bad frame */ } });
    es.addEventListener("problem", () => setStatus("store unreachable"));
    es.onerror = () => setStatus("reconnecting");
    return () => es.close();
  }, [enabled]);
  return { units, status };
}

export default function LiveHardwareWebsiteView(p: Props) {
  const { engine, bridge } = p;
  const amb = p.ambulanceId ? engine.ambulances.get(p.ambulanceId) ?? null : null;
  const j = p.junctionId ? engine.junctions.get(p.junctionId) ?? null : null;
  const [cloudOn, setCloudOn] = useState(false);
  const cloud = useCloud(cloudOn && p.cloudAvailable);

  const tx = amb ? engine.txPacket(amb) : null;
  const decoded = tx ? decodePacket(tx.bytes) : null;
  const nx = amb?.next() ?? null;
  const boardTx = bridge.connected.tx ? (bridge.state.tx.last as TxStatus | null) : null;
  const boardRsu = bridge.connected.rsu ? (bridge.state.rsu.last as RsuStatus | null) : null;
  const rsuIsThis = boardRsu && j && p.rsuBoardJunction === j.id;

  // is this ambulance's packet for this junction? (what the roadside unit decides from next_wp)
  let linkText = "Choose an ambulance and a junction.";
  let forUs = false;
  if (amb && j && decoded?.packet) {
    const d = haversineM(amb.pos, [j.lat, j.lng]);
    const wp = decoded.packet.nextWpLat || decoded.packet.nextWpLng ? haversineM([decoded.packet.nextWpLat, decoded.packet.nextWpLng], [j.lat, j.lng]) : Infinity;
    forUs = wp <= 35;
    linkText =
      amb.arrived || decoded.packet.severity === 0 ? `${amb.id} has its siren off: ${j.id} ignores it.` :
      forUs ? (d > 200 ? `${j.id} is ${amb.id}'s next junction; ${Math.round(d)} m away, it acts at 200 m.` :
        j.served === amb.id ? `${j.id} is ${amb.id}'s next junction, ${Math.round(d)} m away: pre-empted for it.` :
        j.served ? `${j.id} is ${amb.id}'s next junction, ${Math.round(d)} m away: queued behind ${j.served}, which arrives first.` :
        `${j.id} is ${amb.id}'s next junction, ${Math.round(d)} m away: pre-empt.`) :
      `${amb.id} is ${Math.round(d)} m away but its next junction is elsewhere: ${j.id} ignores it.`;
  }

  return (
    <div className="grid h-full gap-4 overflow-auto p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {/* ---------------- ambulance unit */}
      <section aria-labelledby="tx-title" className="rounded-lg border border-rule bg-sheet p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="tx-title" className="text-lg font-extrabold">Ambulance unit</h2>
          <select aria-label="Ambulance" className="rounded border border-rule bg-paper px-2 py-1" value={p.ambulanceId ?? ""} onChange={(e) => p.setAmbulanceId(e.target.value || null)}>
            <option value="">Choose…</option>
            {[...engine.ambulances.values()].map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
          </select>
        </div>
        {!amb || !tx || !decoded?.packet ? (
          <p className="mt-6 text-dim">No ambulance yet. Dispatch one on the map (or run a scenario), then pick it here.</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-4 2xl:grid-cols-4">
              <Readout label="Speed" value={(amb.v * 3.6).toFixed(1)} unit="km/h" />
              <Readout label="Heading" value={`${Math.round(amb.heading)}°`} unit={cardinal(amb.heading)} />
              <Readout label="Progress" value={`${(amb.s / 1000).toFixed(2)}/${(amb.route.length / 1000).toFixed(2)}`} unit="km" />
              <Readout label="Severity" value={decoded.packet.severity ? String(decoded.packet.severity) : "off"} unit={decoded.packet.severity ? "siren on" : "siren"} />
            </div>
            <div className="mt-3 font-mono text-sm text-dim">GPS {decoded.packet.lat.toFixed(7)}, {decoded.packet.lng.toFixed(7)}</div>
            <div className="mt-4 flex items-center gap-3 rounded-md border border-rule p-3" style={{ borderLeft: `6px solid ${ambColor(amb.num)}` }}>
              {nx ? (
                <>
                  <TurnGlyph turn={nx.turn} />
                  <div>
                    <div className="font-extrabold">{nx.turn === "U_TURN" ? "U-turn" : nx.turn === "STRAIGHT" ? "Straight on" : `${nx.turn[0]}${nx.turn.slice(1).toLowerCase()} turn`} at {nx.jid}</div>
                    <div className="text-sm text-dim">in {Math.max(0, Math.round(nx.s - amb.s))} m; Δθ {Math.round(nx.dTheta)}° ({engine.junctions.get(nx.jid)?.topology})</div>
                  </div>
                </>
              ) : (
                <div className="text-dim">{amb.arrived ? "Arrived at the hospital." : "No more roadside units on this route."}</div>
              )}
            </div>
            <h3 className="mb-2 mt-5 font-semibold">Radio packet, 32 bytes, 10 times a second</h3>
            <HexInspector bytes={tx.bytes} compare={boardTx?.hex ?? null} />
            <table className="mt-2 w-full text-sm">
              <tbody className="[&_td]:py-0.5 [&_td:first-child]:pr-3 [&_td:first-child]:text-dim">
                <tr><td>Ambulance</td><td>AMB-{decoded.packet.ambulanceId}</td></tr>
                <tr><td>Next junction</td><td className="font-mono">{decoded.packet.nextWpLat ? `${decoded.packet.nextWpLat.toFixed(7)}, ${decoded.packet.nextWpLng.toFixed(7)}` : "none (0, 0)"}</td></tr>
                <tr><td>Turn there</td><td>{decoded.packet.turn}</td></tr>
                <tr><td>Hospital</td><td className="font-mono">{decoded.packet.destLat.toFixed(5)}, {decoded.packet.destLng.toFixed(5)}</td></tr>
                <tr><td>CRC-8</td><td className="font-mono">0x{decoded.crcReceived.toString(16).padStart(2, "0").toUpperCase()} {decoded.ok ? "valid" : decoded.errors.join("; ")}</td></tr>
              </tbody>
            </table>
            {bridge.connected.tx && (
              <div className="mt-4 rounded-md border border-rule p-3 text-sm">
                <h3 className="font-semibold">Ambulance board says</h3>
                {boardTx ? (
                  <p className="mt-1 text-dim">
                    {boardTx.fix ? `${boardTx.src} position, ${boardTx.spd?.toFixed(1)} km/h, next junction ${(boardTx.next ?? 0) + 1} of ${boardTx.nj}, turn ${boardTx.turn}` : `no position yet (${boardTx.src}, ${boardTx.sats} satellites)`}
                    {boardTx.radio ? `; radio sent ${boardTx.seq ?? 0} packets` : "; nRF24 not found: check wiring"}
                    {p.linkMode === "two" && ". Underlined bytes differ from the simulation's packet: position fields change every tick, so a few always will."}
                  </p>
                ) : <p className="mt-1 text-dim">Waiting for the board…</p>}
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------------- roadside unit */}
      <section aria-labelledby="rsu-title" className="rounded-lg border border-rule bg-sheet p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="rsu-title" className="text-lg font-extrabold">Roadside unit</h2>
          <select aria-label="Junction" className="rounded border border-rule bg-paper px-2 py-1" value={p.junctionId ?? ""} onChange={(e) => p.setJunctionId(e.target.value || null)}>
            <option value="">Choose…</option>
            {[...engine.junctions.values()].map((x) => <option key={x.id} value={x.id}>{x.id}: {x.name}</option>)}
          </select>
        </div>
        <p className={`mt-3 rounded-md p-3 text-sm ${forUs ? "bg-beacon-soft" : "bg-paper"}`}>
          <span className="font-semibold">Radio link, channel 76, 250 kbps. </span>{linkText}
        </p>
        {!j ? (
          <p className="mt-6 text-dim">Pick a junction (or click one on the map).</p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="text-xl font-extrabold">{j.id}: {j.name}</div>
                <div className="text-sm text-dim">{j.topology}, {j.arms.length} arms</div>
              </div>
              <div className="text-right">
                <div className={`text-lg font-extrabold ${j.ctrl.mode === "PREEMPT" ? "text-beacon" : ""}`}>{j.ctrl.mode === "PREEMPT" ? `Pre-empted for ${j.served}` : j.ctrl.mode === "RECOVER" ? "Recovering" : "Normal cycle"}</div>
                <div className="text-sm text-dim">{j.ctrl.phase.replace("_", "-").toLowerCase()} {Number.isFinite(j.ctrl.remaining()) ? `${j.ctrl.remaining().toFixed(1)} s left` : "held for the ambulance"}</div>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap justify-around gap-x-4 gap-y-6">
              {j.arms.map((a) => (
                <PhysicalTrafficSignalHead key={a.idx} lamp={j.ctrl.lamp(a.idx)} label={`From ${a.label}`} road={a.name} gpio={a.gpio} queue={a.queue}
                  served={j.served !== null && j.ctrl.preemptArm === a.idx} />
              ))}
            </div>
            {j.queue.length > 0 && <p className="mt-4 text-sm"><b>Waiting:</b> {j.queue.join(", ")} (served after {j.served})</p>}

            <div className="mt-6 rounded-md border border-rule p-3">
              <h3 className="font-semibold">Roadside board</h3>
              {!bridge.connected.rsu ? (
                <p className="mt-1 text-sm text-dim">Not connected. Connect it in the left panel; it then runs this junction&apos;s lights itself.</p>
              ) : !boardRsu ? (
                <p className="mt-1 text-sm text-dim">Waiting for the board…</p>
              ) : !rsuIsThis ? (
                <p className="mt-1 text-sm text-dim">The board is set up as {p.rsuBoardJunction ?? "nothing"}; choose that junction here to compare.</p>
              ) : (
                <>
                  <div className="mt-3 flex flex-wrap justify-around gap-4">
                    {j.arms.map((a, i) => (
                      <PhysicalTrafficSignalHead key={a.idx} compact lamp={(boardRsu.lamps[i] as Lamp) ?? null} flashYellow={!boardRsu.cfg} label={a.label} />
                    ))}
                  </div>
                  <p className="mt-3 text-sm">
                    Board: <b>{boardRsu.mode.toLowerCase()}</b>
                    {boardRsu.served ? `, serving AMB-${boardRsu.served} on arm ${j.arms[boardRsu.arm]?.label ?? "?"} at ${Math.round(boardRsu.d)} m` : ""}.
                    {" "}Simulation: <b>{j.ctrl.mode.toLowerCase()}</b>{j.served ? `, serving ${j.served} on arm ${j.arms[j.ctrl.preemptArm ?? 0]?.label}` : ""}.
                  </p>
                  <p className="mt-1 text-xs text-dim">
                    The board runs its own clock, so in the normal cycle its phase can differ from the simulation. During a pre-emption both should serve the same arm.
                    Packets: {boardRsu.rx} good, {boardRsu.bad} rejected; {boardRsu.flt} off-route alerts ignored.
                  </p>
                </>
              )}
            </div>
          </>
        )}

        <div className="mt-6 rounded-md border border-rule p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">Units reporting over Wi-Fi</h3>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={cloudOn} disabled={!p.cloudAvailable} onChange={(e) => setCloudOn(e.target.checked)} />
              Live
            </label>
          </div>
          {!p.cloudAvailable ? (
            <p className="mt-1 text-sm text-dim">Cloud telemetry is switched off on this server (no signing secret set).</p>
          ) : !cloudOn ? (
            <p className="mt-1 text-sm text-dim">Turn on to stream signed status from roadside boards with Wi-Fi uplink.</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-dim">Stream: {cloud.status}</p>
              {cloud.units.length === 0 ? <p className="mt-1 text-sm text-dim">No unit has reported in the last minute.</p> : (
                <ul className="mt-2 space-y-1 text-sm">
                  {cloud.units.map((u) => (
                    <li key={u.deviceId} className="flex flex-wrap items-center gap-3">
                      <b>{u.deviceId}</b>
                      <span className="flex gap-1" aria-label={`lamps ${u.lamps}`}>
                        {u.lamps.split("").map((l, i) => <span key={i} className={`h-3 w-3 rounded-full ${l === "G" ? "lamp-on-g" : l === "Y" ? "lamp-on-y" : "lamp-on-r"}`} />)}
                      </span>
                      <span>{u.mode.toLowerCase()}{u.servedAmbId ? ` for ${u.servedAmbId}` : ""}</span>
                      <span className="text-dim">{Math.max(0, Math.round((Date.now() - u.receivedAt) / 1000))} s ago</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </section>
      <span className="sr-only" aria-live="polite">{j?.served ? `${j.id} pre-empted for ${j.served}` : ""}</span>
    </div>
  );
}
