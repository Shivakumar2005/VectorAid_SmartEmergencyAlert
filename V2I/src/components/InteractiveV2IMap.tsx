"use client";
// The map (Leaflet). Drawn imperatively from the engine 20 times a second: roads, roadside units
// (one coloured bar per arm = that arm's lamp), ambulances, their routes, civilian cars and pins.
import L from "leaflet";
import { useEffect, useRef } from "react";
import type { LL } from "@/lib/geo";
import type { Lamp } from "@/lib/v2iPreemptionEngine";
import { DETECT_M } from "@/lib/v2iPreemptionEngine";
import { BEACON, LAMP_HEX, ambColor } from "./colors";
import type { Simulation } from "./useSimulation";

export type PlaceMode = "start" | "dest" | "light" | null;

interface Props {
  sim: Simulation;
  placing: PlaceMode;
  onMapClick: (p: LL) => void;
  pins: { start: LL | null; dest: LL | null };
  selectedJunction: string | null;
  onSelectJunction: (id: string) => void;
  selectedAmbulance: string | null;
  onSelectAmbulance: (id: string) => void;
  tileUrl: string | null; // null: synthetic demo grid, no map tiles under it
  onViewChange?: (bbox: [number, number, number, number], zoom: number) => void;
  flyTo?: { p: LL; zoom: number; k: number } | null;
  visible: boolean;
}

const LAMP_COLOR: Record<Lamp, string> = LAMP_HEX;

function offset(p: LL, bearing: number, d: number): LL {
  const b = (bearing * Math.PI) / 180;
  return [p[0] + (d * Math.cos(b)) / 111320, p[1] + (d * Math.sin(b)) / (111320 * Math.cos((p[0] * Math.PI) / 180))];
}

const ambHtml = (color: string) =>
  `<div class="amb-icon"><svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden="true"><circle r="11" fill="${color}" stroke="#fff" stroke-width="3"/><path d="M0,-7.5 L5,4 L0,1 L-5,4Z" fill="#fff"/></svg></div>`;

const pinIcon = (letter: string, fill: string, text: string, label: string) =>
  L.divIcon({
    className: "",
    html: `<div role="img" aria-label="${label}" style="width:26px;height:26px;border-radius:4px;background:${fill};color:${text};border:2px solid ${BEACON};display:grid;place-items:center;font:800 15px Overpass,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.35)">${letter}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

interface JLayer { center: L.CircleMarker; arms: L.Polyline[]; ring: L.Circle | null; armLen: number; lamps: string[]; style: string }
interface ALayer { marker: L.Marker; route: L.Polyline; done: L.Polyline; color: string }

export default function InteractiveV2IMap(p: Props) {
  const { sim, placing, pins, selectedJunction, selectedAmbulance, tileUrl, flyTo, visible } = p;
  const { engine, tick, graphVersion } = sim;
  const junctionCount = engine.junctions.size;
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const cb = useRef(p);
  cb.current = p;
  const layers = useRef({
    tiles: null as L.TileLayer | null,
    roads: L.layerGroup(),
    candidates: L.layerGroup(),
    junctions: new Map<string, JLayer>(),
    ambulances: new Map<string, ALayer>(),
    cars: [] as L.CircleMarker[],
    start: null as L.Marker | null,
    dest: null as L.Marker | null,
    renderer: null as L.Canvas | null, // things that move: redrawn every tick
    staticRenderer: null as L.Canvas | null, // roads: its own canvas, redrawn only on pan/zoom
  });

  // ---- create the map once
  useEffect(() => {
    const map = L.map(divRef.current!, { preferCanvas: true, zoomControl: true, minZoom: 3, maxZoom: 19 });
    map.setView([12.9645, 77.5945], 15);
    const ly = layers.current;
    ly.staticRenderer = L.canvas({ padding: 0.3 });
    ly.renderer = L.canvas({ padding: 0.3 });
    ly.roads.addTo(map);
    ly.candidates.addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => cb.current.onMapClick([e.latlng.lat, e.latlng.lng]));
    const report = () => {
      const b = map.getBounds();
      cb.current.onViewChange?.([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], map.getZoom());
    };
    map.on("moveend", report);
    mapRef.current = map;
    report();
    return () => {
      map.remove();
      mapRef.current = null;
      ly.junctions.clear();
      ly.ambulances.clear();
      ly.cars = [];
      ly.start = ly.dest = null;
      ly.tiles = null;
    };
  }, []);

  // ---- base map tiles
  useEffect(() => {
    const map = mapRef.current!;
    const ly = layers.current;
    ly.tiles?.remove();
    ly.tiles = null;
    if (tileUrl) {
      ly.tiles = L.tileLayer(tileUrl, {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      }).addTo(map);
    }
    map.attributionControl.setPrefix(tileUrl ? "Leaflet" : "Leaflet | synthetic demo grid");
  }, [tileUrl]);

  // ---- roads (new network)
  useEffect(() => {
    const map = mapRef.current!;
    const ly = layers.current;
    ly.roads.clearLayers();
    for (const j of ly.junctions.values()) { j.center.remove(); j.arms.forEach((a) => a.remove()); j.ring?.remove(); }
    ly.junctions.clear();
    for (const a of ly.ambulances.values()) { a.marker.remove(); a.route.remove(); a.done.remove(); }
    ly.ambulances.clear();
    const g = engine.graph;
    const lines = g.edges.map((e) => e.geom);
    const demo = g.source === "demo";
    if (demo) {
      L.polyline(lines, { color: "#AEB8C3", weight: 13, opacity: 1, interactive: false, renderer: ly.staticRenderer! }).addTo(ly.roads);
      L.polyline(lines, { color: "#F7F9FB", weight: 10, opacity: 1, interactive: false, renderer: ly.staticRenderer! }).addTo(ly.roads);
    } else {
      L.polyline(lines, { color: "#5B6776", weight: 3, opacity: 0.35, interactive: false, renderer: ly.staticRenderer! }).addTo(ly.roads);
    }
    if (g.nodes.size > 1) {
      const [[s, w], [n, e]] = g.bounds();
      map.fitBounds([[s, w], [n, e]], { padding: [30, 30], maxZoom: 17 });
    }
  }, [graphVersion, engine]);

  // ---- where a traffic-light pin can go
  useEffect(() => {
    const ly = layers.current;
    ly.candidates.clearLayers();
    if (placing !== "light") return;
    const taken = new Set([...engine.junctions.values()].map((j) => j.nodeId));
    for (const nd of engine.graph.nodes.values()) {
      const d = engine.graph.degree(nd.id);
      if (d < 3 || d > 5 || taken.has(nd.id)) continue;
      L.circleMarker([nd.lat, nd.lng], { radius: 6, color: BEACON, weight: 2, dashArray: "3 3", fill: false, interactive: false, renderer: ly.staticRenderer! }).addTo(ly.candidates);
    }
  }, [placing, engine, graphVersion, junctionCount]);

  // ---- the map was hidden (hardware twin mode): re-measure the container
  useEffect(() => {
    if (visible) mapRef.current?.invalidateSize();
  }, [visible]);

  // ---- fly-to
  useEffect(() => {
    if (flyTo) mapRef.current?.flyTo(flyTo.p, flyTo.zoom, { duration: 0.8 });
  }, [flyTo]);

  // ---- pins
  useEffect(() => {
    const map = mapRef.current!;
    const ly = layers.current;
    const sync = (key: "start" | "dest", pos: LL | null, icon: L.DivIcon, title: string) => {
      if (!pos) { ly[key]?.remove(); ly[key] = null; return; }
      if (!ly[key]) ly[key] = L.marker(pos, { icon, title, keyboard: false, interactive: false }).addTo(map);
      else ly[key]!.setLatLng(pos);
    };
    sync("start", pins.start, pinIcon("S", "#F7F9FB", BEACON, "Ambulance start"), "Ambulance start");
    sync("dest", pins.dest, pinIcon("H", BEACON, "#fff", "Hospital"), "Hospital");
  }, [pins.start, pins.dest]);

  // ---- everything that moves, every tick
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ly = layers.current;
    const zoom = map.getZoom();
    const mpp = (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** (zoom + 8);
    // a bar is ~26 px long on screen, but never more than 40 % of its street, so bars of
    // neighbouring junctions never run into each other when zoomed out
    const armGeom = (edgeId: string) => {
      const street = engine.graph.edgeById.get(edgeId)?.length ?? 60;
      const gap = Math.min(7 * mpp, 0.12 * street);
      return { gap, len: Math.max(4, Math.min(26 * mpp, 0.4 * street - gap)) };
    };

    // roadside units
    const seen = new Set<string>();
    for (const j of engine.junctions.values()) {
      seen.add(j.id);
      let jl = ly.junctions.get(j.id);
      if (!jl) {
        const center = L.circleMarker([j.lat, j.lng], { radius: 7, color: "#1B2430", weight: 2, fillColor: "#F7F9FB", fillOpacity: 1, renderer: ly.renderer! });
        center.bindTooltip(`${j.id} · ${j.name}`, { direction: "top", offset: [0, -8] });
        center.on("click", (e) => { L.DomEvent.stopPropagation(e); cb.current.onSelectJunction(j.id); });
        const arms = j.arms.map(() => L.polyline([[j.lat, j.lng], [j.lat, j.lng]], { weight: 7, opacity: 1, lineCap: "butt", interactive: false, renderer: ly.renderer! }).addTo(map));
        center.addTo(map);
        jl = { center, arms, ring: null, armLen: -1, lamps: [], style: "" };
        ly.junctions.set(j.id, jl);
      }
      const c: LL = [j.lat, j.lng];
      const moved = jl.armLen !== mpp;
      jl.armLen = mpp;
      j.arms.forEach((a, i) => {
        if (moved) {
          const { gap, len } = armGeom(a.edgeId);
          jl!.arms[i].setLatLngs([offset(c, a.bearing, gap), offset(c, a.bearing, gap + len)]);
        }
        const lamp = j.ctrl.lamp(a.idx);
        if (jl!.lamps[i] !== lamp) { jl!.arms[i].setStyle({ color: LAMP_COLOR[lamp] }); jl!.lamps[i] = lamp; }
      });
      const ringOn = j.served !== null || j.id === selectedJunction;
      if (ringOn && !jl.ring) jl.ring = L.circle(c, { radius: DETECT_M, color: BEACON, weight: 1.5, dashArray: "6 6", fill: j.served !== null, fillOpacity: 0.05, interactive: false }).addTo(map);
      if (!ringOn && jl.ring) { jl.ring.remove(); jl.ring = null; }
      const style = `${j.id === selectedJunction}|${j.served !== null}`;
      if (style !== jl.style) {
        jl.style = style;
        jl.ring?.setStyle({ fill: j.served !== null });
        jl.center.setStyle({ color: j.id === selectedJunction ? BEACON : "#1B2430", weight: j.id === selectedJunction ? 3 : 2, fillColor: j.served ? BEACON : "#F7F9FB" });
      }
    }
    for (const [id, jl] of ly.junctions) if (!seen.has(id)) { jl.center.remove(); jl.arms.forEach((a) => a.remove()); jl.ring?.remove(); ly.junctions.delete(id); }

    // civilian cars (pooled markers)
    const cars = engine.cars;
    while (ly.cars.length < cars.length) ly.cars.push(L.circleMarker([0, 0], { radius: 3.5, stroke: false, fillOpacity: 0.9, interactive: false, renderer: ly.renderer! }).addTo(map));
    while (ly.cars.length > cars.length) ly.cars.pop()!.remove();
    cars.forEach((car, i) => {
      ly.cars[i].setLatLng(engine.carPos(car));
      ly.cars[i].setStyle({ fillColor: car.stopped ? "#2E3742" : "#8792A0" });
    });

    // ambulances and their routes
    const aseen = new Set<string>();
    for (const a of engine.ambulances.values()) {
      aseen.add(a.id);
      const color = a.arrived ? "#8792A0" : ambColor(a.num);
      let al = ly.ambulances.get(a.id);
      if (!al) {
        const route = L.polyline(a.route.pts, { color: ambColor(a.num), weight: 6, opacity: 0.5, interactive: false }).addTo(map);
        const done = L.polyline([], { color: "#8792A0", weight: 6, opacity: 0.6, interactive: false }).addTo(map);
        const marker = L.marker(a.pos, { icon: L.divIcon({ className: "", html: ambHtml(color), iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000, keyboard: false, title: a.id }).addTo(map);
        marker.bindTooltip(a.id, { permanent: true, direction: "right", offset: [12, 0], className: "font-semibold" });
        marker.on("click", (e) => { L.DomEvent.stopPropagation(e); cb.current.onSelectAmbulance(a.id); });
        al = { marker, route, done, color };
        ly.ambulances.set(a.id, al);
      }
      if (al.color !== color) {
        al.marker.setIcon(L.divIcon({ className: "", html: ambHtml(color), iconSize: [30, 30], iconAnchor: [15, 15] }));
        al.color = color;
      }
      al.marker.setLatLng(a.pos);
      const svg = al.marker.getElement()?.querySelector("svg");
      if (svg) svg.style.transform = `rotate(${a.heading}deg)`;
      al.done.setLatLngs(a.route.slice(0, a.s));
      al.route.setStyle({ weight: a.id === selectedAmbulance ? 8 : 6, opacity: a.arrived ? 0.2 : a.id === selectedAmbulance ? 0.75 : 0.5 });
    }
    for (const [id, al] of ly.ambulances) if (!aseen.has(id)) { al.marker.remove(); al.route.remove(); al.done.remove(); ly.ambulances.delete(id); }
  }, [tick, engine, selectedJunction, selectedAmbulance]);

  // Leaflet adds its own classes (leaflet-container: overflow hidden, ...) to the inner div, so React
  // must never re-render that div's className. Our changing classes live on the wrapper.
  return (
    <div className={`v2i-map h-full w-full ${tileUrl ? "" : "demo-grid"} ${placing ? "placing" : ""}`}>
      <div ref={divRef} className="h-full w-full" role="application" aria-label="Simulation map. Click to place the selected pin." />
    </div>
  );
}
