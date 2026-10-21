import { useEffect, useState } from "react";
import { getSeriesDefaults, saveSeriesDefaults, type SeriesStyleDefault, type TrendBucket, type TrendVariable } from "@/lib/apiClient";

/** Per-widget override for one series. axis "auto" (or unset) = grouped by unit. */
export interface SeriesStyle {
  name?: string;
  color?: string;
  axis?: "auto" | "left" | "right";
}
export interface AxisRange {
  min?: number | null;
  max?: number | null;
}
export interface TrendStyling {
  series?: Record<string, SeriesStyle>;
  axes?: { left?: AxisRange; right?: AxisRange };
}

export const SERIES_COLORS = ["#f97316", "#38bdf8", "#a3e635", "#e879f9", "#facc15", "#f87171", "#2dd4bf", "#a78bfa"];

export const BUCKET_OPTIONS: { value: TrendBucket; label: string }[] = [
  { value: "raw", label: "Raw" },
  { value: "5m", label: "5 min" },
  { value: "10m", label: "10 min" },
  { value: "30m", label: "30 min" },
  { value: "hour", label: "1 h" },
  { value: "6h", label: "6 h" },
  { value: "day", label: "1 day" },
];

/** Resolution that keeps roughly ≤ 1500 points per series; 24 h → 10 min. */
export function autoBucket(rangeHours: number): TrendBucket {
  if (rangeHours <= 6) return "raw";
  if (rangeHours <= 12) return "5m";
  if (rangeHours <= 72) return "10m";
  if (rangeHours <= 24 * 10) return "30m";
  if (rangeHours <= 24 * 45) return "hour";
  if (rangeHours <= 24 * 200) return "6h";
  return "day";
}

/* ---- global defaults (shared module cache) ---- */
let cache: Record<string, SeriesStyleDefault> | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function load() {
  if (!inflight)
    inflight = getSeriesDefaults()
      .then((r) => { cache = r.series ?? {}; })
      .catch(() => { cache = cache ?? {}; })
      .finally(notify);
  return inflight;
}

export function useSeriesDefaults() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    void load();
    return () => { listeners.delete(l); };
  }, []);
  const save = async (variableId: string, style: SeriesStyleDefault | null) => {
    const next = { ...(cache ?? {}) };
    if (style && (style.name || style.color || style.axis)) next[variableId] = style;
    else delete next[variableId];
    const r = await saveSeriesDefaults(next);
    cache = r.series;
    notify();
  };
  return { defaults: cache ?? {}, save };
}

/* ---- resolution ---- */
function unitGroup(v: TrendVariable | undefined) {
  if (!v) return "?";
  const u = (v.unit || "").trim().toLowerCase();
  if (u) return u.replace("°", "").replace(/^rh$/, "%");
  const t = `${v.metric} ${v.label}`.toLowerCase();
  if (/humid|rh\b|kosteus/.test(t)) return "%";
  if (/temp|lämpö/.test(t)) return "c";
  return "?";
}

export interface ResolvedSeries {
  id: string;
  name: string;
  color: string;
  axis: "left" | "right";
  unit: string;
}

/** widget override → global default → auto. Auto axis: first unit group left, next group right. */
export function resolveSeries(
  ids: string[],
  variables: Map<string, TrendVariable> | TrendVariable[],
  styling: TrendStyling | undefined,
  defaults: Record<string, SeriesStyleDefault>,
): ResolvedSeries[] {
  const map = Array.isArray(variables) ? new Map(variables.map((v) => [v.id, v])) : variables;
  const leftGroup = ids.map((id) => unitGroup(map.get(id)))[0];
  let rightGroup: string | undefined;
  return ids.map((id, i) => {
    const v = map.get(id);
    const w = styling?.series?.[id] ?? {};
    const g = defaults[id] ?? {};
    let axis: "left" | "right";
    if (w.axis === "left" || w.axis === "right") axis = w.axis;
    else if (g.axis) axis = g.axis;
    else {
      const grp = unitGroup(v);
      if (grp === leftGroup) axis = "left";
      else {
        rightGroup = rightGroup ?? grp;
        axis = grp === rightGroup ? "right" : "left";
      }
    }
    return {
      id,
      name: w.name || g.name || v?.label || id,
      color: w.color || g.color || SERIES_COLORS[i % SERIES_COLORS.length],
      axis,
      unit: v?.unit ?? "",
    };
  });
}

export function axisDomain(r: AxisRange | undefined): [number | "auto", number | "auto"] {
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  return [ok(r?.min) ? (r!.min as number) : "auto", ok(r?.max) ? (r!.max as number) : "auto"];
}

export function axisLabel(series: ResolvedSeries[], side: "left" | "right") {
  const units = Array.from(new Set(series.filter((s) => s.axis === side).map((s) => s.unit).filter(Boolean)));
  return units.join(" / ");
}

/* ---- readable time axis ---- */
const H = 3600_000;
const TICK_STEPS = [10 * 60_000, 30 * 60_000, H, 2 * H, 3 * H, 6 * H, 12 * H, 24 * H, 48 * H, 7 * 24 * H, 14 * 24 * H, 30 * 24 * H];

/** Ticks aligned to local clock/day boundaries, at most one per ~minPx pixels. */
export function timeTicks(fromMs: number, toMs: number, widthPx: number, minPx = 95): number[] {
  if (!(toMs > fromMs) || widthPx <= 0) return [];
  const maxTicks = Math.max(2, Math.floor(widthPx / minPx));
  const step = TICK_STEPS.find((s) => (toMs - fromMs) / s <= maxTicks) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const d = new Date(fromMs);
  if (step >= 24 * H) d.setHours(0, 0, 0, 0);
  else d.setMinutes(0, 0, 0);
  const out: number[] = [];
  let t = d.getTime();
  // walk in local time so DST does not shift day ticks
  while (t <= toMs && out.length < 500) {
    const x = new Date(t);
    const aligned = step >= 24 * H ? true : step >= H ? x.getHours() % (step / H) === 0 && x.getMinutes() === 0 : x.getMinutes() % (step / 60_000) === 0;
    if (t >= fromMs && aligned) out.push(t);
    if (step >= 24 * H) { x.setDate(x.getDate() + step / (24 * H)); t = x.getTime(); }
    else t += Math.min(step, H) === step ? step : H;
  }
  return out;
}

/** "ti 21.10." at midnight (or for day-or-longer steps), otherwise "12:00"; first tick always gets the weekday. */
export function timeTickLabel(ts: number, ticks: number[]): string {
  const d = new Date(ts);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 0;
  const day = d.toLocaleDateString("fi-FI", { weekday: "short", day: "numeric", month: "numeric" }).replace(/\.$/, "") + ".";
  const time = d.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }).replace(".", ":");
  if (step >= 24 * H) return day;
  const midnight = d.getHours() === 0 && d.getMinutes() === 0;
  if (midnight) return day;
  if (ts === ticks[0]) return `${d.toLocaleDateString("fi-FI", { weekday: "short" })} ${time}`;
  return time;
}

export const LEGEND_PROPS = { iconSize: 14, wrapperStyle: { fontSize: 14, lineHeight: "20px", paddingTop: 4 } } as const;
export const AXIS_TICK = { fontSize: 12 } as const;
