import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { getAlarmEvents, getAlarmPoints, setAlarmControls, type AlarmControls, type AlarmEvent, type AlarmPoint } from "@/lib/apiClient";
import { toast } from "sonner";
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
  const [busy, setBusy] = useState(false);
  const [evTick, setEvTick] = useState(0);
  const id = config.pointId;

  const applyControls = async (patch: Partial<Pick<AlarmControls, "on" | "heat" | "cool" | "setpoint">>) => {
    if (!id) return;
    setBusy(true);
    try {
      const r = await setAlarmControls(id, patch);
      if (!r.published) toast.error(`Saved, but MQTT publish failed: ${r.publishError ?? "unknown"}`);
      pointsCache = null;
      const list = await getAlarmPoints();
      setPoint(list.find((p) => p.id === id) ?? null);
      setEvTick((n) => n + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
  }, [id, open, tick, point?.status, evTick]);

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
            {point.controls && (
              <span className="flex flex-wrap gap-1.5" data-testid="mp-controls-compact">
                <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${point.controls.on ? "bg-sky-600 text-white" : "bg-zinc-600 text-zinc-200"}`}>
                  {point.controls.on ? "ON" : "OFF"}
                </span>
                {point.controls.heat && <span className="rounded-full bg-orange-500 px-2.5 py-0.5 text-sm font-medium text-black">HEAT</span>}
                {point.controls.cool && <span className="rounded-full bg-cyan-400 px-2.5 py-0.5 text-sm font-medium text-black">COOL</span>}
                <span className="rounded-full border border-border px-2.5 py-0.5 text-sm">SP {point.controls.setpoint} {point.unit}</span>
              </span>
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
          {point.controls && (
            <ControlsEditor controls={point.controls} unit={point.unit} busy={busy} onChange={applyControls} />
          )}
          {point.status !== null && (
            <div className="font-mono text-xs" data-testid="mp-word">
              word {point.status} = {(point.status >>> 0).toString(2).padStart(16, "0").replace(/(.{4})(?=.)/g, "$1 ")}
            </div>
          )}
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
                    {e.event === "control" ? (
                      <>
                        <span className="rounded bg-sky-700 px-1.5 text-xs font-semibold text-white">CTRL</span>
                        <span>{e.alarm}</span>
                      </>
                    ) : (
                      <>
                        <span
                          className={`rounded px-1.5 text-xs font-semibold ${e.event === "start" ? CHIP[bitLevel(e.alarm)] : "bg-secondary text-foreground"}`}
                        >
                          {e.alarm}
                        </span>
                        <span>{e.event === "start" ? "started" : "cleared"}</span>
                        {e.value !== null && <span className="text-muted-foreground">{e.value.toFixed(1)} {point.unit}</span>}
                      </>
                    )}
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

/** ON/HEAT/COOL toggles and setpoint stepper (0-30). 44 px touch targets. */
function ControlsEditor({
  controls,
  unit,
  busy,
  onChange,
}: {
  controls: AlarmControls;
  unit: string;
  busy: boolean;
  onChange: (patch: Partial<Pick<AlarmControls, "on" | "heat" | "cool" | "setpoint">>) => void;
}) {
  const [sp, setSp] = useState(controls.setpoint);
  useEffect(() => setSp(controls.setpoint), [controls.setpoint]);
  const toggle = (k: "on" | "heat" | "cool", label: string, onCls: string) => (
    <button
      type="button"
      role="switch"
      aria-checked={controls[k]}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange({ [k]: !controls[k] })}
      className={`min-h-11 min-w-[4.5rem] rounded-md border px-3 text-sm font-semibold transition-colors disabled:opacity-50 ${
        controls[k] ? onCls : "border-border bg-secondary/40 text-muted-foreground"
      }`}
    >
      {label} {controls[k] ? "●" : "○"}
    </button>
  );
  const commitSp = (v: number) => {
    const n = Math.max(0, Math.min(30, Math.round(v)));
    setSp(n);
    if (n !== controls.setpoint) onChange({ setpoint: n });
  };
  return (
    <div className="space-y-2 rounded-md border border-border bg-background/40 p-2" data-testid="mp-controls">
      <div className="text-xs font-mono uppercase text-muted-foreground">Controls</div>
      <div className="flex flex-wrap gap-2">
        {toggle("on", "ON", "border-sky-500 bg-sky-600 text-white")}
        {toggle("heat", "HEAT", "border-orange-400 bg-orange-500 text-black")}
        {toggle("cool", "COOL", "border-cyan-300 bg-cyan-400 text-black")}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm">Setpoint</span>
        <button
          type="button"
          aria-label="Setpoint down"
          disabled={busy || sp <= 0}
          onClick={() => commitSp(sp - 1)}
          className="h-11 w-11 rounded-md border border-border text-xl disabled:opacity-40"
        >
          −
        </button>
        <input
          aria-label="Setpoint"
          type="number"
          inputMode="numeric"
          min={0}
          max={30}
          step={1}
          value={sp}
          disabled={busy}
          onChange={(e) => setSp(Number(e.target.value))}
          onBlur={() => commitSp(sp)}
          onKeyDown={(e) => e.key === "Enter" && commitSp(sp)}
          className="h-11 w-16 rounded-md border border-input bg-background text-center text-lg tabular-nums"
        />
        <button
          type="button"
          aria-label="Setpoint up"
          disabled={busy || sp >= 30}
          onClick={() => commitSp(sp + 1)}
          className="h-11 w-11 rounded-md border border-border text-xl disabled:opacity-40"
        >
          +
        </button>
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      {controls.updatedAt && (
        <div className="text-[11px] text-muted-foreground">
          changed {fmt(controls.updatedAt)}{controls.updatedBy ? ` · ${controls.updatedBy}` : ""}
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
