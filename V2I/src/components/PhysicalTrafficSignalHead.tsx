// One 3-aspect signal head as it hangs over an arm: red on top, then yellow, then green, each with
// the GPIO that drives it on the roadside ESP32-S3 and that pin's level.
import type { Lamp } from "@/lib/v2iPreemptionEngine";

interface Props {
  lamp: Lamp | null; // null: dark (unit not configured / board not connected)
  flashYellow?: boolean;
  label: string;
  road?: string;
  gpio?: [number, number, number];
  queue?: number;
  served?: boolean;
  compact?: boolean;
}

const ASPECTS: { key: Lamp; name: string; cls: string }[] = [
  { key: "R", name: "Red", cls: "lamp-on-r" },
  { key: "Y", name: "Yellow", cls: "lamp-on-y" },
  { key: "G", name: "Green", cls: "lamp-on-g" },
];

export default function PhysicalTrafficSignalHead({ lamp, flashYellow, label, road, gpio, queue, served, compact }: Props) {
  const size = compact ? "h-7 w-7" : "h-11 w-11";
  const lit = (k: Lamp) => (flashYellow ? k === "Y" : lamp === k);
  const desc = flashYellow ? "flashing yellow" : lamp ? ASPECTS.find((a) => a.key === lamp)!.name.toLowerCase() : "dark";
  return (
    <figure className="flex flex-col items-center gap-2" aria-label={`Arm ${label}${road ? ` (${road})` : ""}: ${desc}`}>
      <div className={`relative rounded-[14px] bg-housing ${compact ? "px-2 py-2" : "px-3 py-3"} shadow-[inset_0_-3px_0_rgba(0,0,0,.35)] ${served ? "ring-4 ring-beacon" : ""}`}>
        <div className="flex flex-col gap-2">
          {ASPECTS.map((a) => (
            <div key={a.key} className="relative">
              <div className={`${size} rounded-full ${lit(a.key) ? a.cls : "lamp-off"} ${flashYellow && a.key === "Y" ? "animate-pulse" : ""}`} />
              {!compact && <div className="pointer-events-none absolute -top-1 left-1/2 h-3 w-14 -translate-x-1/2 rounded-t-full border-t-4 border-[#14191F]" />}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="text-center leading-tight">
        <div className="text-base font-extrabold">{label}</div>
        {road && <div className="max-w-[9rem] truncate text-xs text-dim" title={road}>{road}</div>}
      </figcaption>
      {gpio && (
        <dl className="grid grid-cols-[auto_auto] gap-x-2 font-mono text-[11px] leading-4 text-dim">
          {ASPECTS.map((a, i) => (
            <div key={a.key} className="contents">
              <dt>GPIO {gpio[i]}</dt>
              <dd className={lit(a.key) ? "font-semibold text-ink" : ""}>{lit(a.key) ? "HIGH" : "LOW"}</dd>
            </div>
          ))}
        </dl>
      )}
      {queue !== undefined && (
        <div className="w-full" title={`${queue} cars queued`}>
          <div className="h-1.5 w-full rounded bg-rule">
            <div className="h-1.5 rounded bg-ink" style={{ width: `${Math.min(100, (queue / 8) * 100)}%` }} />
          </div>
          <div className="mt-0.5 text-center text-[11px] text-dim">{queue} queued</div>
        </div>
      )}
    </figure>
  );
}
