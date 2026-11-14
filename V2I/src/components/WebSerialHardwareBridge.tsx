"use client";
// Connects the simulation to real boards over USB (Web Serial, Chrome / Edge).
//
//  One board (RSU only): the browser sends every simulated ambulance's 32-byte packet to the
//    roadside board as "PKT,<hex>" 10 times a second. The board's own controller decides and
//    drives its LEDs: the radio is not used.
//  Two boards: the browser feeds the ambulance board the selected ambulance's position ("SIM,...")
//    and route junctions; that board transmits over the nRF24 and the roadside board receives it.
//
// Either way the roadside board is configured as one of the simulated junctions ("CFG,...").
import { useCallback, useEffect, useRef, useState } from "react";
import type { V2IEngine } from "@/lib/v2iPreemptionEngine";
import { toHex } from "@/lib/rf24PacketCodec";
import { LinePort, parseBoardLine, serialSupported, type RsuStatus, type TxStatus } from "@/lib/webSerial";
import { TURN_CODE } from "./colors";

export type LinkMode = "one" | "two";
type Role = "tx" | "rsu";

export interface BoardState {
  connected: boolean;
  radio: boolean | null;
  last: TxStatus | RsuStatus | null;
  lastAt: number;
  note: string;
}

const empty = (): BoardState => ({ connected: false, radio: null, last: null, lastAt: 0, note: "" });

export function useHardwareBridge(engine: V2IEngine, rsuJunctionId: string | null, txAmbulanceId: string | null, mode: LinkMode) {
  const ports = useRef<Record<Role, LinePort | null>>({ tx: null, rsu: null });
  const state = useRef<Record<Role, BoardState>>({ tx: empty(), rsu: empty() });
  const [connected, setConnected] = useState<Record<Role, boolean>>({ tx: false, rsu: false });
  const [log, setLog] = useState<string[]>([]);
  const sentCfg = useRef<string>("");
  const sentRoute = useRef<string>("");
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const sel = useRef({ rsuJunctionId, txAmbulanceId, mode });
  sel.current = { rsuJunctionId, txAmbulanceId, mode };

  const note = useCallback((m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40)), []);

  const onLine = useCallback((role: Role, line: string) => {
    const msg = parseBoardLine(line);
    const st = state.current[role];
    if (!msg) return;
    if (msg.t === "hello") {
      const h = msg as { role?: string; radio?: number };
      st.radio = h.radio === 1;
      if (h.role && h.role.toLowerCase() !== role) note(`warning: the ${role.toUpperCase()} port is a ${h.role} board`);
      // the board (re)started: send its configuration again
      if (role === "rsu") sentCfg.current = "";
      if (role === "tx") sentRoute.current = "";
    } else if (msg.t === "tx" || msg.t === "rsu") {
      st.last = msg as TxStatus | RsuStatus;
      st.lastAt = performance.now();
      st.radio = (msg as { radio?: number }).radio === 1;
    } else if (msg.t === "err") {
      note(`${role.toUpperCase()} board: ${line}`);
    } else if (msg.t === "route") {
      note(`TX board stored the route (${(msg as { junctions?: number }).junctions} junctions)`);
    }
  }, [note]);

  const connect = useCallback(async (role: Role) => {
    try {
      const p = await LinePort.request(
        (line) => onLine(role, line),
        (why) => {
          ports.current[role] = null;
          state.current[role] = empty();
          setConnected((c) => ({ ...c, [role]: false }));
          note(`${role.toUpperCase()} board disconnected: ${why}`);
        },
      );
      ports.current[role] = p;
      state.current[role] = { ...empty(), connected: true };
      if (role === "rsu") sentCfg.current = "";
      if (role === "tx") sentRoute.current = "";
      setConnected((c) => ({ ...c, [role]: true }));
      note(`${role.toUpperCase()} board connected`);
      p.send("PING");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/No port selected/i.test(m)) note(`could not open the port: ${m}`);
    }
  }, [note, onLine]);

  const disconnect = useCallback(async (role: Role) => {
    const p = ports.current[role];
    ports.current[role] = null;
    state.current[role] = empty();
    setConnected((c) => ({ ...c, [role]: false }));
    await p?.close();
  }, []);

  const send = useCallback((role: Role, line: string) => ports.current[role]?.send(line), []);

  // 10 Hz: configuration when it changes, then the live feed
  useEffect(() => {
    const id = setInterval(() => {
      const e = engineRef.current;
      const { rsuJunctionId: jid, txAmbulanceId: aid, mode: m } = sel.current;
      const rsu = ports.current.rsu;
      const tx = ports.current.tx;
      if (rsu) {
        const j = jid ? e.junctions.get(jid) : null;
        const cfg = j ? `CFG,${j.id},${j.lat.toFixed(7)},${j.lng.toFixed(7)},${j.arms.length},${j.arms.map((a) => a.bearing.toFixed(1)).join(",")}` : "CLR";
        if (cfg !== sentCfg.current) {
          rsu.send(cfg);
          sentCfg.current = cfg;
          note(j ? `RSU board configured as ${j.id} (${j.topology}, ${j.arms.length} arms)` : "RSU board cleared (flashing yellow)");
        }
        if (m === "one" && j) for (const a of e.ambulances.values()) rsu.send(`PKT,${toHex(e.txPacket(a).bytes, "")}`);
      }
      if (tx) {
        const a = aid ? e.ambulances.get(aid) : null;
        if (a) {
          const key = `${a.id}|${a.route.length.toFixed(1)}|${a.routeJunctions.map((r) => r.jid + r.turn).join(",")}|${a.siren && !a.arrived ? a.severity : 0}`;
          if (key !== sentRoute.current) {
            const [dl, dn] = a.dest;
            tx.send(`ID,${a.num & 0xff}`);
            tx.send(`SEV,${a.siren && !a.arrived ? a.severity : 0}`);
            tx.send(`DEST,${dl.toFixed(7)},${dn.toFixed(7)}`);
            tx.send("JCLR");
            a.routeJunctions.forEach((r, i) => {
              const j = e.junctions.get(r.jid);
              if (j) tx.send(`J,${i},${j.lat.toFixed(7)},${j.lng.toFixed(7)},${TURN_CODE[r.turn]}`);
            });
            tx.send("JEND");
            sentRoute.current = key;
          }
          const [lat, lng] = a.pos;
          tx.send(`SIM,${lat.toFixed(7)},${lng.toFixed(7)},${(a.v * 3.6).toFixed(1)},${a.heading.toFixed(1)}`);
        }
      }
    }, 100);
    return () => clearInterval(id);
  }, [note]);

  useEffect(() => () => { void ports.current.tx?.close(); void ports.current.rsu?.close(); }, []);

  return { connected, state: state.current, log, connect, disconnect, send };
}

export type HardwareBridge = ReturnType<typeof useHardwareBridge>;

// ------------------------------------------------------------------ the panel
interface PanelProps {
  bridge: HardwareBridge;
  engine: V2IEngine;
  mode: LinkMode;
  setMode: (m: LinkMode) => void;
  rsuJunctionId: string | null;
  setRsuJunctionId: (id: string | null) => void;
  txAmbulanceId: string | null;
  setTxAmbulanceId: (id: string | null) => void;
}

function Dot({ on, label }: { on: boolean | null; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-dim">
      <span className={`h-2 w-2 rounded-full ${on === null ? "bg-rule" : on ? "bg-sig-g" : "bg-sig-r"}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export default function WebSerialHardwareBridge(p: PanelProps) {
  const { bridge, engine, mode } = p;
  const supported = serialSupported();
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  const board = (role: Role, title: string, help: string) => {
    const st = bridge.state[role];
    const live = bridge.connected[role] && now - st.lastAt < 1500;
    return (
      <div className="rounded-md border border-rule bg-sheet p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{title}</h3>
          {bridge.connected[role] ? (
            <button className="rounded border border-rule px-2 py-1 text-sm hover:bg-paper" onClick={() => void bridge.disconnect(role)}>Disconnect</button>
          ) : (
            <button className="rounded bg-beacon px-2 py-1 text-sm font-semibold text-white disabled:opacity-40" disabled={!supported} onClick={() => void bridge.connect(role)}>Connect</button>
          )}
        </div>
        <p className="mt-1 text-xs text-dim">{help}</p>
        {bridge.connected[role] && (
          <div className="mt-2 flex flex-wrap gap-3">
            <Dot on={live} label={live ? "reporting" : "silent"} />
            <Dot on={st.radio} label={st.radio === null ? "radio ?" : st.radio ? "nRF24 found" : "nRF24 not found"} />
          </div>
        )}
      </div>
    );
  };

  return (
    <section aria-labelledby="hw-title" className="space-y-3">
      <h2 id="hw-title" className="text-lg font-extrabold">Boards over USB</h2>
      {!supported && (
        <p className="rounded-md border border-sig-r/40 bg-sheet p-3 text-sm">
          This browser has no Web Serial. Open the page in Chrome or Edge on a desktop (over HTTPS or on localhost) to connect boards.
        </p>
      )}
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-sm font-semibold">How the boards get the ambulance</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="link" checked={mode === "one"} onChange={() => p.setMode("one")} className="mt-1" />
          <span><b>One board.</b> The page sends every simulated ambulance&apos;s packet to the roadside board over USB. No radio needed.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="link" checked={mode === "two"} onChange={() => p.setMode("two")} className="mt-1" />
          <span><b>Two boards.</b> The ambulance board transmits by nRF24; the roadside board receives it. Only the ambulance chosen below is on air.</span>
        </label>
      </fieldset>

      <label className="block text-sm">
        <span className="font-semibold">Roadside board acts as</span>
        <select className="mt-1 w-full rounded border border-rule bg-sheet px-2 py-1.5" value={p.rsuJunctionId ?? ""} onChange={(e) => p.setRsuJunctionId(e.target.value || null)}>
          <option value="">No junction (flashing yellow)</option>
          {[...engine.junctions.values()].map((j) => (
            <option key={j.id} value={j.id}>{j.id}: {j.name} ({j.arms.length} arms)</option>
          ))}
        </select>
      </label>
      {board("rsu", "Roadside unit (RSU)", "ESP32-S3 + nRF24 + LEDs, running roadside_rx_esp32s3.")}

      <label className="block text-sm">
        <span className="font-semibold">Ambulance board follows</span>
        <select className="mt-1 w-full rounded border border-rule bg-sheet px-2 py-1.5" value={p.txAmbulanceId ?? ""} onChange={(e) => p.setTxAmbulanceId(e.target.value || null)}>
          <option value="">No ambulance</option>
          {[...engine.ambulances.values()].map((a) => (
            <option key={a.id} value={a.id}>{a.id}{a.arrived ? " (arrived)" : ""}</option>
          ))}
        </select>
      </label>
      {board("tx", "Ambulance unit (TX)", mode === "two" ? "ESP32-S3 + NEO-M8N + nRF24, running ambulance_tx_esp32s3. Gets its position from the simulation." : "Optional in one-board mode.")}

      {bridge.log.length > 0 && (
        <details className="text-xs" open>
          <summary className="cursor-pointer font-semibold">Connection log</summary>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto font-mono text-dim">
            {bridge.log.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
