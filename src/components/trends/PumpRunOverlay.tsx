// Pump run lanes for trend charts (Circ L/R, Fill, FertDose).
import { useEffect, useState, type ReactNode } from "react";
import { ReferenceArea, YAxis } from "recharts";
import { getPumpRuns, type PumpRunInterval, type PumpRunMeta } from "@/lib/apiClient";

export const DEFAULT_PUMP_META: PumpRunMeta[] = [
  { id: "circ_l", label: "Kiertopumppu L", color: "#34d399" },
  { id: "circ_r", label: "Kiertopumppu R", color: "#38bdf8" },
  { id: "fill", label: "Täyttöpumppu", color: "#fbbf24" },
  { id: "fert", label: "Lannoite", color: "#c084fc" },
];

export function usePumpRuns(enabled: boolean, from: string, to: string) {
  const [pumps, setPumps] = useState<PumpRunMeta[]>(DEFAULT_PUMP_META);
  const [intervals, setIntervals] = useState<PumpRunInterval[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !from || !to) {
      setIntervals([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      getPumpRuns(from, to)
        .then((d) => {
          if (cancelled) return;
          setPumps(d.pumps?.length ? d.pumps : DEFAULT_PUMP_META);
          setIntervals(d.intervals ?? []);
          setErr(null);
        })
        .catch((e) => {
          if (!cancelled) setErr((e as Error).message);
        });
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [enabled, from, to]);
  return { pumps, intervals, err };
}

function fmtDur(s: number) {
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} h ${m} min`;
}

export function fmtPumpRunTip(iv: PumpRunInterval, meta?: PumpRunMeta) {
  const label = meta?.label ?? iv.pump;
  const d = new Date(iv.startMs);
  const start = `${d.getDate()}.${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  // Täyttöpumpulla kesto on oleellinen; muilla riittää tieto että kävi (+ lyhyt kesto).
  if (iv.pump === "fill") {
    return `${label}: alku ${start} · kesto ${fmtDur(iv.duration_s)}${iv.open ? " (käy)" : ""}`;
  }
  return `${label}: ${start}${iv.open ? " (käy)" : ""}`;
}

/** Legend chips + optional master toggle row. */
export function PumpRunLegend({
  pumps, visible, onToggle, counts, master, onMaster,
}: {
  pumps: PumpRunMeta[];
  visible: Record<string, boolean>;
  onToggle: (id: string) => void;
  counts?: Record<string, number>;
  master: boolean;
  onMaster: (on: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="pump-run-legend">
      <label className="flex items-center gap-1.5 rounded border border-border px-2 py-1 font-mono">
        <input type="checkbox" checked={master} onChange={(e) => onMaster(e.target.checked)} data-testid="pump-runs-toggle" />
        Pumpun käynnit
      </label>
      {master && pumps.map((p) => (
        <button
          key={p.id}
          type="button"
          data-testid={`pump-run-${p.id}`}
          onClick={() => onToggle(p.id)}
          className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono transition-opacity ${visible[p.id] !== false ? "border-border bg-background/60" : "border-border/40 opacity-40"}`}
          title={p.label}
        >
          <span className="h-2 w-3 rounded-sm" style={{ background: p.color }} />
          {p.label}
          {counts && <span className="text-muted-foreground">{counts[p.id] ?? 0}</span>}
        </button>
      ))}
    </div>
  );
}

/** Recharts children: hidden pump axis + ReferenceArea lanes (min visual width). */
export function renderPumpRunAreas(
  intervals: PumpRunInterval[],
  pumps: PumpRunMeta[],
  visible: Record<string, boolean>,
  xMin: number,
  xMax: number,
  chartWidth: number,
) {
  const span = Math.max(1, xMax - xMin);
  // ~10 px min so 1 s FertDose pulses stay visible even on 6–24 h charts
  const minMs = Math.max(5_000, span * (10 / Math.max(chartWidth || 600, 100)));
  const meta = Object.fromEntries(pumps.map((p) => [p.id, p]));
  const laneOf = Object.fromEntries(pumps.map((p, i) => [p.id, i]));
  const out: ReactNode[] = [
    <YAxis key="ax-pumps" yAxisId="pumps" hide domain={[0, Math.max(4, pumps.length)]} />,
  ];
  for (const iv of intervals) {
    if (visible[iv.pump] === false) continue;
    const m = meta[iv.pump];
    if (!m) continue;
    const lane = laneOf[iv.pump] ?? 0;
    let x1 = Math.max(xMin, iv.startMs);
    let x2 = Math.min(xMax, iv.endMs);
    if (x2 < x1) continue;
    if (x2 - x1 < minMs) x2 = Math.min(xMax, x1 + minMs);
    out.push(
      <ReferenceArea
        key={`pr-${iv.pump}-${iv.startMs}`}
        yAxisId="pumps"
        x1={x1}
        x2={x2}
        y1={lane + 0.12}
        y2={lane + 0.88}
        fill={m.color}
        fillOpacity={0.55}
        stroke={m.color}
        strokeOpacity={0.35}
        strokeWidth={1}
        ifOverflow="hidden"
      >
        <title>{fmtPumpRunTip(iv, m)}</title>
      </ReferenceArea>,
    );
  }
  return out;
}

export function pumpRunsAt(ts: number, intervals: PumpRunInterval[], pumps: PumpRunMeta[]) {
  const meta = Object.fromEntries(pumps.map((p) => [p.id, p]));
  return intervals
    .filter((iv) => ts >= iv.startMs && ts <= iv.endMs)
    .map((iv) => fmtPumpRunTip(iv, meta[iv.pump]));
}
