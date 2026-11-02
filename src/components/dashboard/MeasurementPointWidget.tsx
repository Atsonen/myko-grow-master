import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Settings, X } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { getAlarmEvents, getAlarmPoints, setAlarmControls, type AlarmControls, type AlarmControlsPatch, type AlarmEvent, type AlarmLimits, type AlarmPoint } from "@/lib/apiClient";
import { toast } from "sonner";
import { useDashboardData } from "./DashboardData";
import { PID_KEY_BY_POINT, PidCompact, OutputGauge, PidControlTab, PidStateTab, PidModeBanner, pidAbnormal, pidModeIndication, usePid } from "./PidFaceplate";
import { PidParamsEditor } from "./PidParamsEditor";
import { PidAiTab, usePidAiBadge } from "./PidAiTab";
import type { WidgetConfigMap } from "./types";


const LS_DIALOG_SIZE = "myko.pidFaceplate.size"; // normal | wide | full
const LS_DIALOG_W = "myko.pidFaceplate.widthPx";
type DialogSizeMode = "normal" | "wide" | "full";
const SIZE_WIDTH: Record<DialogSizeMode, number> = { normal: 720, wide: 1100, full: 0 };
function loadDialogSize(): { mode: DialogSizeMode; widthPx: number | null } {
  try {
    const mode = (localStorage.getItem(LS_DIALOG_SIZE) as DialogSizeMode) || "normal";
    const w = Number(localStorage.getItem(LS_DIALOG_W));
    const ok = mode === "normal" || mode === "wide" || mode === "full";
    return { mode: ok ? mode : "normal", widthPx: Number.isFinite(w) && w >= 480 ? w : null };
  } catch { return { mode: "normal", widthPx: null }; }
}
function saveDialogSize(mode: DialogSizeMode, widthPx: number | null) {
  try {
    localStorage.setItem(LS_DIALOG_SIZE, mode);
    if (widthPx && mode !== "full") localStorage.setItem(LS_DIALOG_W, String(Math.round(widthPx)));
  } catch { /* ignore */ }
}

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

export type PointLevel = "ok" | "warn" | "alarm" | "unknown" | "disabled";
export function pointLevel(p: AlarmPoint): PointLevel {
  if (p.status === null) return "unknown";
  const levels = p.active.map((k) => p.bits.find((b) => b.key === k)?.level ?? "alarm");
  if (levels.includes("alarm")) return "alarm";
  if (levels.length) return "warn";
  return "ok";
}

export function alarmsDisabled(p: AlarmPoint) {
  const u = p.controls?.alarmsDisabledUntil;
  return Boolean(u && new Date(u).getTime() > Date.now());
}
const hm = (iso: string) => new Date(iso).toLocaleTimeString("fi-FI", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit" });
const n1 = (x: number) => String(Math.round(x * 10) / 10).replace(".", ",");
/** Rule text for the setpoint-relative bits, built from the current limits. */
function relativeRule(key: string, c: AlarmControls, unit: string): string | null {
  const { setpoint: sp, limits: l } = c;
  if (!l) return null;
  if (key === "WARN")
    return l.warnBoth
      ? `|value − SP| > ${n1(l.warnDelta)} ${unit} (outside ${n1(sp - l.warnDelta)}…${n1(sp + l.warnDelta)}) for ${l.warnMin} min`
      : `> SP+${n1(l.warnDelta)} = ${n1(sp + l.warnDelta)} ${unit} for ${l.warnMin} min`;
  if (key === "HIGH") return `> SP+${n1(l.highDelta)} = ${n1(sp + l.highDelta)} ${unit} for ${l.highMin} min`;
  if (key === "LOW") return `< SP−${n1(l.lowDelta)} = ${n1(sp - l.lowDelta)} ${unit} for ${l.lowMin} min`;
  return null;
}

// ISA-101 / high-performance HMI: neutral gray when normal, colour only for abnormal states.
// The surrounding dashboard Card is the only frame; abnormal states add an inset ring to it.
const LEVEL_STYLE: Record<PointLevel, string> = {
  disabled: "outline-dashed outline-1 -outline-offset-4 outline-zinc-500",
  ok: "",
  warn: "ring-2 ring-inset ring-amber-400 bg-amber-400/[0.06]",
  alarm: "ring-2 ring-inset ring-red-500 bg-red-500/[0.10]",
  unknown: "",
};
const CHIP: Record<string, string> = {
  warn: "text-amber-300",
  alarm: "text-red-400",
};

/** ISA-101 alarm indicator: priority 1 = red square "1", priority 2 = yellow triangle "2". */
export function AlarmIndicator({ level, className = "h-5 w-5" }: { level: string; className?: string }) {
  if (level === "alarm")
    return (
      <span className={`inline-flex shrink-0 items-center justify-center bg-red-600 text-[11px] font-bold leading-none text-white ${className}`} aria-label="priority 1 alarm">1</span>
    );
  return (
    <svg viewBox="0 0 20 18" className={`shrink-0 ${className}`} aria-label="priority 2 warning">
      <polygon points="10,1 19,17 1,17" fill="#facc15" />
      <text x="10" y="15" textAnchor="middle" fontSize="10" fontWeight="700" fill="#000">2</text>
    </svg>
  );
}
const MUTED = "text-sm text-muted-foreground";
/** Muted pastel tints for active control states (ISA-101: distinct from alarm red/yellow, inactive stays gray). */
export const CTRL_TINT = { on: "text-[#a8d5b5]", heat: "text-[#d9b08f]", cool: "text-[#a9c8e8]" } as const;
const CTRL_TOGGLE = {
  on: "border-[#a8d5b5]/60 bg-[#a8d5b5]/15 text-[#a8d5b5]",
  heat: "border-[#d9b08f]/60 bg-[#d9b08f]/15 text-[#d9b08f]",
  cool: "border-[#a9c8e8]/60 bg-[#a9c8e8]/15 text-[#a9c8e8]",
} as const;

/** "Mittauspiste": a measurement point with alarm status from an external checker. */
export function MeasurementPointWidget({ config, open: openProp, onOpenChange, dialogOnly = false }: {
  config: WidgetConfigMap["measurementPoint"];
  /** controlled dialog (e.g. opened from the Plants process graphic) */
  open?: boolean; onOpenChange?: (o: boolean) => void;
  /** render only the faceplate dialog, no card */
  dialogOnly?: boolean;
}) {
  const { tick } = useDashboardData();
  const [point, setPoint] = useState<AlarmPoint | null>(null);
  const [events, setEvents] = useState<AlarmEvent[]>([]);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => { setOpenState(o); onOpenChange?.(o); };
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [evTick, setEvTick] = useState(0);
  const id = config.pointId;
  const pidKey = id ? PID_KEY_BY_POINT[id] : undefined;
  const pid = usePid(pidKey, open ? 2000 : 5000, false); // trend loaded in PidControlTab with rangeHours
  const [aiNew, clearAiNew] = usePidAiBadge(pidKey);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [gaugeSize, setGaugeSize] = useState(88);
  const [dlgSize, setDlgSize] = useState<DialogSizeMode>(() => loadDialogSize().mode);
  const [dlgWidth, setDlgWidth] = useState<number | null>(() => loadDialogSize().widthPx);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  // Size gauge from available card width/height so Mittauspiste fills the widget without overflow/scrollbar.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      // Leave room for title + status rows; grow with the shorter side.
      const byW = w >= 240 ? Math.min(140, w * 0.38) : Math.min(96, w * 0.55);
      const byH = Math.max(52, Math.min(140, h * 0.42));
      const next = Math.round(Math.max(52, Math.min(byW, byH)));
      setGaugeSize((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const applyControls = async (patch: AlarmControlsPatch): Promise<boolean> => {
    if (!id) return false;
    setBusy(true);
    try {
      const r = await setAlarmControls(id, patch);
      if (!r.published) toast.error(`Saved, but MQTT publish failed: ${r.publishError ?? "unknown"}`);
      pointsCache = null;
      const list = await getAlarmPoints();
      setPoint(list.find((p) => p.id === id) ?? null);
      setEvTick((n) => n + 1);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
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
    getAlarmEvents(id, 50).then((e) => !cancelled && setEvents(e)).catch(() => undefined);
    return () => { cancelled = true; };
  }, [id, open, tick, point?.status, evTick]);

  if (!id) return <div className="text-xs text-muted-foreground italic">Pick a measurement point in widget settings.</div>;
  if (err) return dialogOnly ? null : <div className="text-xs text-destructive">{err}</div>;
  if (!point) return dialogOnly ? null : <div className="text-xs text-muted-foreground italic">Loading…</div>;

  const pidAbn = pidKey ? pidAbnormal(pid) : [];
  const modeInd = pidKey ? pidModeIndication(pid) : null;
  const baseLevel = pointLevel(point);
  const level: PointLevel = pidAbn.some((a) => a.level === "alarm") ? "alarm" : pidAbn.length && (baseLevel === "ok" || baseLevel === "unknown") ? "warn" : baseLevel;
  const disabled = alarmsDisabled(point);
  const active = point.active; // disabling only mutes WhatsApp; state/colour stay live
  const bitLevel = (k: string) => point.bits.find((b) => b.key === k)?.level ?? "alarm";
  const value = point.current?.value ?? point.alarmValue;
  const checkedAgeMin = point.checked ? (Date.now() - new Date(point.checked).getTime()) / 60_000 : Infinity;

  const TAB = "min-h-11 flex-1 whitespace-nowrap rounded-md px-1.5 text-[13px] min-[400px]:px-3 min-[400px]:text-sm font-semibold text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow";
  return (
    <div ref={cardRef} className={`@container relative flex h-full min-h-0 flex-col overflow-hidden px-3 py-2.5 ${dialogOnly ? "hidden" : ""} ${LEVEL_STYLE[level]} ${disabled && (level === "ok" || level === "unknown") && !modeInd ? LEVEL_STYLE.disabled : ""} ${modeInd?.outline ?? ""}`} data-testid="measurement-point" data-level={level}>
      <PidModeBanner ind={modeInd} className="mb-1.5 mr-9 w-auto shrink-0" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-evenly gap-1 overflow-hidden">
        <div className="min-w-0 shrink-0 truncate pr-9 text-[15px] font-medium leading-6 text-muted-foreground" data-testid="mp-name">{config.name || point.name}</div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-1 @[15rem]:flex-row @[15rem]:items-center @[15rem]:gap-3">
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="text-3xl font-semibold tabular-nums leading-none text-foreground @[10rem]:text-4xl @[16rem]:text-5xl" data-testid="mp-value">
              {value === null || value === undefined ? "—" : value.toFixed(1)}
            </span>
            <span className="text-sm text-muted-foreground @[10rem]:text-base @[16rem]:text-lg">{point.unit}</span>
          </span>
          {pidKey && pid.v && (
            <span
              className={`shrink-0 self-center @[15rem]:ml-auto ${pid.stale ? "opacity-60" : ""}`}
              style={{ width: gaugeSize, maxWidth: "100%" }}
            >
              <OutputGauge v={pid.v} size={gaugeSize} />
            </span>
          )}
        </div>
        <div className="mt-0.5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="mp-chips">
          {active.length === 0 ? (
            <span className={MUTED}>Normaali</span>
          ) : (
            active.map((k) => (
              <span key={k} className={`inline-flex items-center gap-1.5 text-sm font-semibold ${CHIP[bitLevel(k)]}`}>
                <AlarmIndicator level={bitLevel(k)} />
                {k}
              </span>
            ))
          )}
        </div>
        {pidKey && <PidCompact v={pid.v} stale={pid.stale} unit={point.unit} />}
        {pidKey && aiNew && <div className="mt-0.5 inline-block shrink-0 rounded bg-amber-900/60 px-1.5 py-0.5 text-[11px] font-semibold text-amber-200" data-testid="pid-ai-badge">AI-ehdotus</div>}
        {pidAbn.length > 0 && (
          <div className="mt-0.5 flex shrink-0 flex-wrap gap-x-3 gap-y-1" data-testid="pid-abn">
            {pidAbn.map((a) => (
              <span key={a.text} className={`inline-flex items-center gap-1.5 text-sm font-semibold ${CHIP[a.level]}`}><AlarmIndicator level={a.level} />{a.text}</span>
            ))}
          </div>
        )}
        {disabled && (
          <div className={`${MUTED} shrink-0`} data-testid="mp-disabled">WhatsApp-hälytykset pois {hm(point.controls!.alarmsDisabledUntil!)} asti</div>
        )}
        {point.controls && (
          <div className={`mt-0.5 flex shrink-0 flex-wrap gap-x-3 ${MUTED}`} data-testid="mp-controls-compact">
            <span className={point.controls.on ? CTRL_TINT.on : ""} data-testid="mp-on">{point.controls.on ? "ON" : "OFF"}</span>
            {point.controls.heat && <span className={CTRL_TINT.heat}>HEAT</span>}
            {point.controls.cool && <span className={CTRL_TINT.cool}>COOL</span>}
            {!pidKey && <span>SP {point.controls.setpoint} {point.unit}</span>}
            {checkedAgeMin > 5 && <span title="Alarm checker has not reported recently">checker {fmt(point.checked)}</span>}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${point.name}: asetukset`}
        data-testid="mp-gear"
        className="absolute right-1 top-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-secondary/60 hover:text-foreground"
      >
        <Settings className="h-[18px] w-[18px]" />
      </button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" data-testid="mp-backdrop" />
          <DialogPrimitive.Content
            data-testid="mp-dialog"
            aria-describedby={undefined}
            data-size={dlgSize}
            className="fixed z-50 flex flex-col border bg-background shadow-lg inset-0 overscroll-contain md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(90vh,900px)] md:w-[var(--mp-dialog-w)] md:max-w-[min(98vw,1600px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg [@media(max-height:560px)]:inset-0 [@media(max-height:560px)]:h-auto [@media(max-height:560px)]:w-auto [@media(max-height:560px)]:max-w-none [@media(max-height:560px)]:translate-x-0 [@media(max-height:560px)]:translate-y-0 [@media(max-height:560px)]:rounded-none"
            style={{
              ["--mp-dialog-w" as string]:
                dlgSize === "full" ? "min(98vw, 1600px)" : `min(98vw, ${dlgWidth ?? SIZE_WIDTH[dlgSize]}px)`,
            }}
          >
            {/* Left-edge drag handle (desktop): widen/narrow the faceplate */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Muuta dialogin leveyttä"
              data-testid="mp-dialog-resize"
              className="absolute bottom-8 left-0 top-8 z-10 hidden w-2 cursor-ew-resize md:block"
              onPointerDown={(e) => {
                e.preventDefault();
                const el = e.currentTarget.parentElement;
                const startW = el?.getBoundingClientRect().width ?? SIZE_WIDTH.normal;
                dragRef.current = { startX: e.clientX, startW };
                const move = (ev: PointerEvent) => {
                  if (!dragRef.current) return;
                  // Dragging the left edge right shrinks; left grows.
                  const next = Math.max(480, Math.min(1600, dragRef.current.startW + (dragRef.current.startX - ev.clientX)));
                  setDlgWidth(next);
                  setDlgSize(next >= 1300 ? "full" : next >= 900 ? "wide" : "normal");
                };
                const up = () => {
                  dragRef.current = null;
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  setDlgWidth((cur) => {
                    const mode: DialogSizeMode = (cur ?? 720) >= 1300 ? "full" : (cur ?? 720) >= 900 ? "wide" : "normal";
                    saveDialogSize(mode, cur);
                    setDlgSize(mode);
                    return cur;
                  });
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            >
              <div className="mx-auto h-full w-1 rounded-full bg-zinc-600/80 hover:bg-zinc-400" />
            </div>
            <div className={`flex items-center gap-3 border-b border-border p-3 ${LEVEL_STYLE[level]}`}>
              <div className="min-w-0 flex-1">
                <PidModeBanner ind={modeInd} className="mb-1" />
                <DialogPrimitive.Title className="truncate text-lg font-semibold">{config.name || point.name}</DialogPrimitive.Title>
                <div className="text-sm text-muted-foreground tabular-nums">
                  {value === null || value === undefined ? "—" : value.toFixed(1)} {point.unit}
                  {point.controls ? ` · SP ${point.controls.setpoint} ${point.unit}` : ""}
                  {active.length ? ` · ${active.join(", ")}` : " · Normaali"}
                  {disabled ? ` · WhatsApp-hälytykset pois ${hm(point.controls!.alarmsDisabledUntil!)} asti` : ""}
                </div>
              </div>
              <div className="hidden shrink-0 items-center gap-1 md:flex" role="radiogroup" aria-label="Dialogin leveys">
                {([
                  ["normal", "Normaali"],
                  ["wide", "Leveä"],
                  ["full", "Koko näyttö"],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={dlgSize === mode}
                    data-testid={`mp-size-${mode}`}
                    title={label}
                    onClick={() => {
                      setDlgSize(mode);
                      const w = mode === "full" ? null : SIZE_WIDTH[mode];
                      setDlgWidth(w);
                      saveDialogSize(mode, w);
                    }}
                    className={`h-9 rounded-md border px-2 text-[11px] font-semibold ${
                      dlgSize === mode
                        ? "border-zinc-300 bg-zinc-200 text-zinc-900"
                        : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/70"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <DialogPrimitive.Close aria-label="Sulje" data-testid="mp-close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground">
                <X className="h-5 w-5" />
              </DialogPrimitive.Close>
            </div>
            <TabsPrimitive.Root defaultValue={pidKey ? "saato" : "tila"} className="flex min-h-0 flex-1 flex-col">
              <TabsPrimitive.List className="m-3 mb-0 flex gap-1 overflow-x-auto rounded-lg bg-muted p-1" data-testid="mp-tabs">
                {pidKey ? (
                  <>
                    <TabsPrimitive.Trigger value="saato" className={TAB}>Säätö</TabsPrimitive.Trigger>
                    <TabsPrimitive.Trigger value="pidtila" className={TAB}>Tila</TabsPrimitive.Trigger>
                    <TabsPrimitive.Trigger value="param" className={TAB}>Parametrit</TabsPrimitive.Trigger>
                    <TabsPrimitive.Trigger value="ai" className={TAB} data-testid="tab-ai">AI-analyysi{aiNew && <span className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" aria-label="uusi ehdotus" />}</TabsPrimitive.Trigger>
                    <TabsPrimitive.Trigger value="tila" className={TAB}>Hälytykset</TabsPrimitive.Trigger>
                  </>
                ) : (
                  <>
                    <TabsPrimitive.Trigger value="tila" className={TAB}>Tila</TabsPrimitive.Trigger>
                    <TabsPrimitive.Trigger value="ohjaus" className={TAB}>Ohjaus</TabsPrimitive.Trigger>
                  </>
                )}
                <TabsPrimitive.Trigger value="rajat" className={TAB}>{pidKey ? "Rajat" : "Hälytysrajat"}</TabsPrimitive.Trigger>
                <TabsPrimitive.Trigger value="tapahtumat" className={TAB}>Tapahtumat</TabsPrimitive.Trigger>
              </TabsPrimitive.List>
              <TabsPrimitive.Content value="tila" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm" data-testid="mp-details">
                <div className="space-y-1.5">
                  {point.bits.map((b) => {
                    const on = active.includes(b.key);
                    const rule = (point.controls && relativeRule(b.key, point.controls, point.unit)) || b.rule;
                    return (
                      <div key={b.bit} className="flex items-start gap-2" data-bit={b.bit} data-on={on ? "1" : "0"}>
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                          {on ? <AlarmIndicator level={b.level} /> : <span className="h-3 w-3 rounded-full border border-zinc-500" />}
                        </span>
                        <span className={`w-20 shrink-0 font-mono ${on ? `font-semibold ${CHIP[b.level]}` : "text-muted-foreground"}`}>{b.key}</span>
                        <span className="min-w-0 flex-1 text-muted-foreground">
                          {rule}
                          {on && <span className="block text-xs text-foreground">since {fmt(point.since?.[b.key])}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {point.status !== null && (
                  <div className="font-mono text-xs" data-testid="mp-word">
                    word {point.status} = {(point.status >>> 0).toString(2).padStart(16, "0").replace(/(.{4})(?=.)/g, "$1 ")}
                  </div>
                )}
                {point.status !== null && (
                  <div className="space-y-1 border-t border-border pt-2" data-testid="mp-ctrlbits">
                    {([[7, "ON", "ohjaus päällä"], [8, "HEAT", "lämmitys (PID-rajatilassa vakio 1)"], [9, "COOL", "jäähdytys (PID-rajatilassa vakio 1)"], [15, "WA_DIS", "WhatsApp-hälytykset pois"]] as const).map(([bit, key, txt]) => {
                      const on = ((point.status! >>> bit) & 1) === 1;
                      return (
                        <div key={bit} className="flex items-start gap-2" data-bit={bit} data-on={on ? "1" : "0"}>
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                            <span className={`h-3 w-3 rounded-full border ${on ? "border-zinc-300 bg-zinc-300" : "border-zinc-500"}`} />
                          </span>
                          <span className={`w-20 shrink-0 font-mono ${on ? "" : "text-muted-foreground"}`}>{key}</span>
                          <span className="text-muted-foreground">bit {bit} · {txt}</span>
                        </div>
                      );
                    })}
                    <div className="flex items-start gap-2 text-muted-foreground">
                      <span className="h-5 w-5 shrink-0" />
                      <span className="w-20 shrink-0 font-mono">SP</span>
                      <span>bit 10–14 · asetusarvo {(point.status! >>> 10) & 0x1f} {point.unit}</span>
                    </div>
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  Reading {fmt(point.current?.timestamp ?? point.lastReading)} · checked {fmt(point.checked)}
                </div>
              </TabsPrimitive.Content>
              {pidKey && (
                <>
                  <TabsPrimitive.Content value="saato" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
                    <PidControlTab pidKey={pidKey} pid={pid} unit={point.unit}
                      trendHeight={dlgSize === "full" ? 240 : dlgSize === "wide" || (dlgWidth ?? 0) >= 900 ? 200 : 140}
                      onSetpoint={(sp) => applyControls({ setpoint: sp })} />
                    {point.controls && (
                      <>
                        <ControlsEditor controls={point.controls} unit={point.unit} busy={busy} onChange={applyControls} hideSetpoint />
                        <AlarmDisable controls={point.controls} busy={busy} onChange={applyControls} />
                      </>
                    )}
                  </TabsPrimitive.Content>
                  <TabsPrimitive.Content value="pidtila" className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
                    <PidStateTab v={pid.v} at={pid.at} unit={point.unit} />
                  </TabsPrimitive.Content>
                  <TabsPrimitive.Content value="param" className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
                    <PidParamsEditor pidKey={pidKey} v={pid.v} />
                  </TabsPrimitive.Content>
                  <TabsPrimitive.Content value="ai" className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
                    <PidAiTab pidKey={pidKey} onSeen={clearAiNew} />
                  </TabsPrimitive.Content>
                </>
              )}
              <TabsPrimitive.Content value="ohjaus" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
                {point.controls ? (
                  <>
                    <ControlsEditor controls={point.controls} unit={point.unit} busy={busy} onChange={applyControls} />
                    <AlarmDisable controls={point.controls} busy={busy} onChange={applyControls} />
                  </>
                ) : (
                  <div className="text-xs italic text-muted-foreground">No controls for this point.</div>
                )}
              </TabsPrimitive.Content>
              <TabsPrimitive.Content value="rajat" className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
                {point.controls?.limits ? (
                  <LimitsEditor controls={point.controls} unit={point.unit} busy={busy} onSave={(limits) => applyControls({ limits })} />
                ) : (
                  <div className="text-xs italic text-muted-foreground">No editable limits for this point.</div>
                )}
              </TabsPrimitive.Content>
              <TabsPrimitive.Content value="tapahtumat" className="min-h-0 flex-1 overflow-y-auto p-3 text-sm" data-testid="mp-events-tab">
                {events.length === 0 ? (
                  <div className="text-xs italic text-muted-foreground">No alarm events recorded yet.</div>
                ) : (
                  <ul className="space-y-1" data-testid="mp-events">
                    {events.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-x-2">
                        <span className="w-28 shrink-0 tabular-nums text-muted-foreground">{fmt(e.at)}</span>
                        {e.event === "control" ? (
                          <>
                            <span className="rounded border border-border px-1.5 text-xs text-muted-foreground">CTRL</span>
                            <span>{e.alarm}</span>
                          </>
                        ) : (
                          <>
                            <span className={`inline-flex items-center gap-1 text-xs font-semibold ${e.event === "start" ? CHIP[bitLevel(e.alarm)] : "text-muted-foreground"}`}>
                              {e.event === "start" && <AlarmIndicator level={bitLevel(e.alarm)} className="h-4 w-4" />}
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
              </TabsPrimitive.Content>
            </TabsPrimitive.Root>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

/** ON/HEAT/COOL toggles and setpoint stepper (0-30). 44 px touch targets. */
function ControlsEditor({
  controls,
  unit,
  busy,
  onChange,
  hideSetpoint = false,
}: {
  controls: AlarmControls;
  unit: string;
  busy: boolean;
  onChange: (patch: AlarmControlsPatch) => void;
  hideSetpoint?: boolean;
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
    const n = Math.max(0, Math.min(30, Math.round(v * 10) / 10));
    setSp(n);
    if (n !== controls.setpoint) onChange({ setpoint: n });
  };
  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="mp-controls">
      <div className="text-xs font-mono uppercase text-muted-foreground">Controls</div>
      <div className="flex flex-wrap gap-2">
        {toggle("on", "ON", CTRL_TOGGLE.on)}
        {toggle("heat", "HEAT", CTRL_TOGGLE.heat)}
        {toggle("cool", "COOL", CTRL_TOGGLE.cool)}
      </div>
      {hideSetpoint && (
        <div className="text-xs text-muted-foreground" data-testid="mp-hc-caption">
          HEAT/COOL ohjaa PID_Temp-lähtörajaa: Heat pois = Heat-yläraja 0, Cool pois = Cool-alaraja 0 (rajatilassa).
        </div>
      )}
      {!hideSetpoint && <div className="flex items-center gap-2">
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
          step={0.1}
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
      </div>}
      {controls.updatedAt && (
        <div className="text-[11px] text-muted-foreground">
          changed {fmt(controls.updatedAt)}{controls.updatedBy ? ` · ${controls.updatedBy}` : ""}
        </div>
      )}
    </div>
  );
}

const DISABLE_CHOICES: [number, string][] = [[30, "30 min"], [60, "1 h"], [240, "4 h"], [480, "8 h"]];
/** Temporarily disable alarms (no WhatsApp, alarm bits 0); duration is mandatory, max 24 h. */
function AlarmDisable({ controls, busy, onChange }: { controls: AlarmControls; busy: boolean; onChange: (p: AlarmControlsPatch) => void }) {
  const until = controls.alarmsDisabledUntil;
  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="mp-disable">
      <div className="text-xs font-mono uppercase text-muted-foreground">WhatsApp-hälytykset</div>
      {until ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">WhatsApp-hälytykset pois {fmt(until)} asti</span>
          <button type="button" disabled={busy} onClick={() => onChange({ disableMinutes: 0 })}
            className="min-h-11 rounded-md border border-zinc-400 bg-zinc-200 text-zinc-900 px-3 text-sm font-semibold disabled:opacity-50">
            Palauta nyt
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">WhatsApp-hälytykset pois</span>
          {DISABLE_CHOICES.map(([m, label]) => (
            <button key={m} type="button" disabled={busy} onClick={() => onChange({ disableMinutes: m })}
              className="min-h-11 min-w-[3.5rem] rounded-md border border-border bg-secondary/40 px-3 text-sm font-semibold disabled:opacity-50">
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="text-[11px] text-muted-foreground">Vain WhatsApp-viestit vaimennetaan; hälytysbitit, PLC, väri ja tapahtumaloki toimivat normaalisti. Palautuu automaattisesti ajan päätyttyä (WhatsApp-ilmoitus).</div>
    </div>
  );
}

/** Setpoint-relative alarm limits. Validation mirrors the backend. */
function LimitsEditor({ controls, unit, busy, onSave }: {
  controls: AlarmControls; unit: string; busy: boolean; onSave: (l: AlarmLimits) => Promise<boolean>;
}) {
  const toForm = (l: AlarmLimits) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v)]));
  const [f, setF] = useState<Record<string, string | boolean>>(() => toForm(controls.limits));
  useEffect(() => setF(toForm(controls.limits)), [JSON.stringify(controls.limits)]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (k: string) => Number(String(f[k]).replace(",", "."));
  const errors: string[] = [];
  for (const k of ["warnDelta", "highDelta", "lowDelta"]) {
    const v = num(k);
    if (!(v >= 0.1 && v <= 20) || Math.abs(v * 10 - Math.round(v * 10)) > 1e-9) errors.push(`${k.replace("Delta", "").toUpperCase()} Δ 0.1…20`);
  }
  for (const k of ["warnMin", "highMin", "lowMin"]) {
    const v = num(k);
    if (!(Number.isInteger(v) && v >= 0 && v <= 1440)) errors.push(`${k.replace("Min", "").toUpperCase()} time 0…1440 min`);
  }
  if (!errors.length && num("highDelta") < num("warnDelta")) errors.push("HIGH Δ must be ≥ WARN Δ");
  if (!errors.length && f.warnBoth && num("lowDelta") < num("warnDelta")) errors.push("LOW Δ must be ≥ WARN Δ");
  const next: AlarmLimits = {
    warnDelta: num("warnDelta"), warnMin: num("warnMin"), warnBoth: Boolean(f.warnBoth),
    highDelta: num("highDelta"), highMin: num("highMin"), lowDelta: num("lowDelta"), lowMin: num("lowMin"),
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(controls.limits);
  const sp = controls.setpoint;
  const row = (label: string, sign: string, dk: string, mk: string, abs: number) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-12 font-mono text-sm">{label}</span>
      <span className="text-sm">{sign}</span>
      <input aria-label={`${label} delta`} inputMode="decimal" value={String(f[dk])} disabled={busy}
        onChange={(e) => setF({ ...f, [dk]: e.target.value })}
        className="h-11 w-16 rounded-md border border-input bg-background text-center tabular-nums" />
      <span className="text-sm text-muted-foreground">{unit} for</span>
      <input aria-label={`${label} minutes`} inputMode="numeric" value={String(f[mk])} disabled={busy}
        onChange={(e) => setF({ ...f, [mk]: e.target.value })}
        className="h-11 w-16 rounded-md border border-input bg-background text-center tabular-nums" />
      <span className="text-sm text-muted-foreground">min{Number.isFinite(abs) ? ` (${n1(abs)} ${unit})` : ""}</span>
    </div>
  );
  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="mp-limits">
      <div className="text-xs font-mono uppercase text-muted-foreground">Alarm limits (relative to SP {sp} {unit})</div>
      {row("WARN", f.warnBoth ? "±" : "+", "warnDelta", "warnMin", f.warnBoth ? NaN : sp + num("warnDelta"))}
      <label className="flex min-h-11 items-center gap-2 pl-14 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={Boolean(f.warnBoth)} disabled={busy}
          onChange={(e) => setF({ ...f, warnBoth: e.target.checked })} />
        WARN both directions (±)
      </label>
      {row("HIGH", "+", "highDelta", "highMin", sp + num("highDelta"))}
      {row("LOW", "−", "lowDelta", "lowMin", sp - num("lowDelta"))}
      {errors.length > 0 && <div className="text-xs text-destructive">{errors.join(" · ")}</div>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !dirty || errors.length > 0} onClick={() => onSave(next)}
          className="min-h-11 rounded-md border border-zinc-400 bg-zinc-200 text-zinc-900 px-4 text-sm font-semibold disabled:opacity-40">
          Save limits
        </button>
        {dirty && (
          <button type="button" disabled={busy} onClick={() => setF(toForm(controls.limits))}
            className="min-h-11 rounded-md border border-border px-4 text-sm">Reset</button>
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">CRIT, FREEZE/COLD, FLATLINE and STALE are fixed. Checker applies changes on its next run.</div>
    </div>
  );
}

export function usePointList() {
  const [list, setList] = useState<AlarmPoint[]>([]);
  useEffect(() => { getAlarmPoints().then(setList).catch(() => undefined); }, []);
  return list;
}
