"use client";
// Owns the simulation engine and its clock. The engine is plain TypeScript (src/lib); React only
// re-renders 20 times a second from `tick`, while the engine steps every animation frame.
import { useCallback, useEffect, useRef, useState } from "react";
import { RoadGraph, demoGrid } from "@/lib/roadGraph";
import { V2IEngine } from "@/lib/v2iPreemptionEngine";

const STEP_S = 0.05;

export function useSimulation() {
  const engineRef = useRef<V2IEngine | null>(null);
  if (!engineRef.current) {
    const e = new V2IEngine(demoGrid());
    // a roadside unit at every junction of the demo grid (3 to 5 arms)
    for (const nd of e.graph.nodes.values()) {
      const d = e.graph.degree(nd.id);
      if (d >= 3 && d <= 5) e.addJunctionAt([nd.lat, nd.lng]);
    }
    e.setDensity("medium");
    engineRef.current = e;
  }
  const [tick, setTick] = useState(0);
  const [graphVersion, setGraphVersion] = useState(0);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const runningRef = useRef(running);
  const speedRef = useRef(speed);
  runningRef.current = running;
  speedRef.current = speed;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastPub = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000); // a background tab does not make the sim jump
      last = now;
      if (runningRef.current) {
        let left = dt * speedRef.current;
        while (left > 1e-6) {
          const h = Math.min(STEP_S, left);
          engineRef.current!.step(h);
          left -= h;
        }
      }
      if (now - lastPub >= 50) {
        lastPub = now;
        setTick((t) => t + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /** Swap the road network (keeps density, drops junctions and ambulances). */
  const replaceGraph = useCallback((g: RoadGraph, placeSignals = true): V2IEngine => {
    const old = engineRef.current!;
    const e = new V2IEngine(g);
    if (placeSignals && g.source === "demo") {
      for (const nd of g.nodes.values()) if (g.degree(nd.id) >= 3 && g.degree(nd.id) <= 5) e.addJunctionAt([nd.lat, nd.lng]);
    } else if (placeSignals) e.autoPlaceJunctions(12);
    e.setDensity(old.density);
    engineRef.current = e;
    setGraphVersion((v) => v + 1);
    return e;
  }, []);

  /** Same network, nothing on it. */
  const reset = useCallback((): V2IEngine => {
    const old = engineRef.current!;
    const e = new V2IEngine(old.graph);
    e.setDensity(old.density);
    engineRef.current = e;
    setGraphVersion((v) => v + 1);
    return e;
  }, []);

  return { engine: engineRef.current!, tick, graphVersion, running, setRunning, speed, setSpeed, replaceGraph, reset };
}

export type Simulation = ReturnType<typeof useSimulation>;
