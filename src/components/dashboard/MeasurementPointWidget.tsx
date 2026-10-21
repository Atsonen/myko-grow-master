import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { getAlarmEvents, getAlarmPoints, type AlarmEvent, type AlarmPoint } from "@/lib/apiClient";
import { useDashboardData } from "./DashboardData";
import type { WidgetConfigMap } from "./types";

const HEL: Intl.DateTimeFormatOptions = { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" };
const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("fi-FI", HEL) : "—");

/** Shared, minute-refreshed point list so several widgets make one request. */
let pointsCache: { at: number; tick: number; data: AlarmPoint[] } | null = null;
let pointsInflight: Promise<AlarmPoint[]> | null = null;
function loadPoints(tick: number) {
  if (pointsCache && pointsCache.tick === tick) return Promise.resolve(pointsCache.data);
  if (!pointsInflight)
    pointsInflight = getAlarmPoints()
      .then((d) => { pointsCache = { at: Date.now(), tick, data: d }; return d; })
      .finally(() => { pointsInflight = null; });
  return pointsInflight;
}

export type PointLevel = "ok" | "warn" | "alarm" | "unknown";
export function pointLevel(p: AlarmPoint): PointLevel {
  if (p.status === null) return "unknown";
  const levels = p.active.map((k) => p.bits.find((b) => b.key === k)?.level ?? "alarm");
  if (levels.includes("alarm")) return "alarm";
  if (levels.length) return "warn";
  return "ok";
}

const LEVEL_STYLE: Record<PointLevel, string> = {
  ok: "bg-emerald-500/10 border-emerald-500/40",
  warn: "bg-amber-500/20 border-amber-400/70",
  alarm: "bg-red-600/25 border-red-500",
  unknown: "bg-secondary/30 border-border",
};
const CHIP: Record<string, string> = {
  warn: "bg-amber-400 text-black",
  alarm: "bg-red-600 text-white",
};

/** "Mittauspiste": a measurement point with alarm status from an external checker. */
export function MeasurementPointWidget({ config }: { config: WidgetConfigMap["measurementPoint"] }) {
  const { tick } = useDashboardData();
  const [point, setPoint] = useState<AlarmPoint | null>(null);
  const [events, setEvents] = useState<AlarmEvent[]>([]);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const id = config.pointId;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    loadPoints(tick)
      .then((list) => { if (!cancelled) { setPoint(list.find((p) => p.id === id) ?? null); setErr(""); } })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => { cancelled = true; };
  }, [id, tick]);

  useEffect(() => {
    if (!id || !open) return;
    let cancelled = false;
    getAlarmEvents(id, 20).then((e) => !cancelled && setEvents(e)).catch(() => undefined);
    return () => { cancelled = true; };
  }, [id, open, tick, point?.status]);

  if (!id) return <div className="text-xs text-muted-foreground italic">Pick a measurement point in widget settings.</div>;
  if (err) return <div className="text-xs text-destructive">{err}</div>;
  if (!point) return <div className="text-xs text-muted-foreground italic">Loading…</div>;

  const level = pointLevel(point);
  const bitLevel = (k: string) => point.bits.find((b) => b.key === k)?.level ?? "alarm";
  const value = point.current?.value ?? point.alarmValue;
  const checkedAgeMin = point.checked ? (Date.now() - new Date(point.checked).getTime()) / 60_000 : Infinity;

  return (
    <div
      className={`rounded-md border-2 p-3 transition-colors ${LEVEL_STYLE[level]} ${open ? "" : "h-full"}`}
      data-testid="measurement-point"
      data-level={level}
    >
      <button
        type="button"
        className="flex w-full min-h-11 items-start gap-3 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${point.name}: ${open ? "hide" : "show"} details`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium" data-testid="mp-name">{config.name || point.name}</div>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-semibold tabular-nums" data-testid="mp-value">
              {value === null || value === undefined ? "—" : value.toFixed(1)}
            </span>
            <span className="text-base text-muted-foreground">{point.unit}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5" data-testid="mp-chips">
            {point.active.length === 0 ? (
              <span className="rounded-full bg-emerald-600/80 px-2.5 py-0.5 text-sm font-medium text-white">OK</span>
            ) : (
              point.active.map((k) => (
                <span key={k} className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${CHIP[bitLevel(k)]}`}>{k}</span>
              ))
            )}
            {checkedAgeMin > 5 && (
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-sm text-muted-foreground" title="Alarm checker has not reported recently">
                checker {fmt(point.checked)}
              </span>
            )}
          </div>
        </div>
        {open ? <ChevronUp className="mt-1 h-5 w-5 shrink-0" /> : <ChevronDown className="mt-1 h-5 w-5 shrink-0" />}
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-sm" data-testid="mp-details">
          <div className="space-y-1">
            {point.bits.map((b) => {
              const on = point.active.includes(b.key);
              return (
                <div key={b.bit} className="flex items-start gap-2" data-bit={b.bit} data-on={on ? "1" : "0"}>
                  <span
                    className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full"
                    style={{ background: on ? (b.level === "alarm" ? "#ef4444" : "#f59e0b") : "#3f3f46" }}
                  />
                  <span className={`w-20 shrink-0 font-mono ${on ? "font-semibold" : "text-muted-foreground"}`}>{b.key}</span>
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    {b.rule}
                    {on && <span className="block text-xs text-foreground">since {fmt(point.since?.[b.key])}</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="text-xs text-muted-foreground">
            Reading {fmt(point.current?.timestamp ?? point.lastReading)} · checked {fmt(point.checked)} · word {point.status ?? "—"}
          </div>
          <div>
            <div className="mb-1 text-xs font-mono uppercase text-muted-foreground">Recent events</div>
            {events.length === 0 ? (
              <div className="text-xs italic text-muted-foreground">No alarm events recorded yet.</div>
            ) : (
              <ul className="space-y-0.5" data-testid="mp-events">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-2">
                    <span className="w-28 shrink-0 tabular-nums text-muted-foreground">{fmt(e.at)}</span>
                    <span
                      className={`rounded px-1.5 text-xs font-semibold ${e.event === "start" ? CHIP[bitLevel(e.alarm)] : "bg-secondary text-foreground"}`}
                    >
                      {e.alarm}
                    </span>
                    <span>{e.event === "start" ? "started" : "cleared"}</span>
                    {e.value !== null && <span className="text-muted-foreground">{e.value.toFixed(1)} {point.unit}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function usePointList() {
  const [list, setList] = useState<AlarmPoint[]>([]);
  useEffect(() => { getAlarmPoints().then(setList).catch(() => undefined); }, []);
  return list;
}
