/**
 * Kasvamo Prosessikuva widget – SVG process view with editable element boxes.
 * Used as dashboard widget type "processDiagram" (shared DashboardGrid).
 */
import { DisableDuration, untilLabel, useNow, reEnableAlarm } from "@/lib/alarmDisable";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Minus, Pencil, Plus, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FertDosePanel, FertEcModal, useFertDose } from "@/components/FertDosePanel";
import { useSequence } from "@/components/SequencePanel";
import { getDataloggerLatest, getKasvamoAlarms, putKasvamoAlarms, type KasvamoAlarms, type KasLimit, getPumput, getPvFeed, type DataloggerLatest, type PumputResponse, setFertPumpEnable, setCircPumpEnable } from "@/lib/apiClient";
import { toast } from "sonner";
import { MeasurementPointWidget } from "@/components/dashboard/MeasurementPointWidget";
import { usePid, PID_STATE } from "@/components/dashboard/PidFaceplate";
import {
  DEFAULT_PROCESS_BOXES,
  DEFAULT_PROCESS_ZOOM,
  PROCESS_VIEW_H,
  PROCESS_VIEW_W,
  clientToSvg,
  clampBox,
  clampProcessZoom,
  loadProcessLayout,
  mergeProcessBoxes,
  resetProcessLayout,
  saveProcessLayout,
  type ProcessBox,
  type ProcessBoxMap,
  type ProcessZoom,
} from "@/lib/processLayout";

// Signals identified by matching HMI screenshot values (23.10.2026 ~14:05) to datalogger values.
const TAGS = {
  level: "dl25", // Level %
  waterTemp: "dl24", // Water Temp
  ec: "dl23", // ppm
  ph: "dl26", // pH
  fan: "dl04", // PF-1 %
  ductTemp: "dl31", // G Poistoilma DS4
  roofTemp: "dl30", // G Katto DS3
  midTemp: "dl03", // G Mid DS2
  g1Temp: "dl09", // G1 temp TT
} as const;
type TagName = keyof typeof TAGS;
const POLL_MS = 5000;

// Pumput_DB (OPC UA, väliaikainen): vain luku. Kytketty vain yksiselitteiset signaalit.
function usePumput() {
  const [p, setP] = useState<PumputResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getPumput().then((d) => alive && setP(d)).catch(() => undefined);
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const ok = p && !p.stale;
  const b = (k: string) => (ok && typeof p.values[k] === "boolean" ? (p.values[k] as boolean) : undefined);
  const n = (k: string) => (ok && typeof p.values[k] === "number" ? (p.values[k] as number) : undefined);
  return { ok, b, n };
}

// Kasvamo-hälytysrajat (Myko-asetus kasvamo_alarms, backend kasvamoAlarms.js). Ei PLC-kirjoituksia.
function useKasAlarms() {
  const [a, setA] = useState<KasvamoAlarms | null>(null);
  const load = () => getKasvamoAlarms().then(setA).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  return { a, setA, load };
}
const limTxt = (L?: KasLimit) => (!L ? undefined : !L.enabled ? (L.disabled_until ? untilLabel(L.disabled_until).replace(/ \(.*\)$/, "") : "pois") : `${L.lo ?? ""}–${L.hi ?? ""}`);

function AlarmDialog({ sig, data, onClose, onSaved }: { sig: string | null; data: KasvamoAlarms | null; onClose: () => void; onSaved: (d: KasvamoAlarms) => void }) {
  const L = sig && data ? data.config.limits[sig] : undefined; const S = sig && data ? data.signals[sig] : undefined;
  const [f, setF] = useState({ lo: "", hi: "", hyst: "", enabled: true, delay: "" }); const [disMin, setDisMin] = useState(60); const now = useNow(15_000);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (L && data) setF({ lo: L.lo == null ? "" : String(L.lo), hi: L.hi == null ? "" : String(L.hi), hyst: String(L.hyst ?? 0), enabled: L.enabled !== false, delay: String(data.config.delay_min) });
    setErr(null);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!sig) return; setBusy(true); setErr(null);
    const n = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
    try {
      const d = await putKasvamoAlarms({ delay_min: Number(f.delay.replace(",", ".")), disable_min: !f.enabled && L?.enabled !== false ? disMin : undefined, limits: { [sig]: { lo: n(f.lo), hi: n(f.hi), hyst: n(f.hyst) ?? 0, enabled: f.enabled } } });
      onSaved(d); onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const inp = "w-full rounded border border-border bg-background px-2 py-1 font-mono text-sm";
  return (
    <Dialog open={!!sig} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm font-mono">
        <DialogHeader><DialogTitle className="text-base">Hälytysrajat · {S?.name} {S?.unit && `(${S.unit})`}</DialogTitle></DialogHeader>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Hälytys käytössä</label>
          {L?.enabled === false && L.disabled_until && (
            <div className="flex items-center justify-between gap-2 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-300" data-testid="kas-dis-until">
              <span>🔕 {untilLabel(L.disabled_until, now)}</span>
              <button type="button" className="rounded border border-amber-400 px-2 py-0.5" disabled={busy} onClick={async () => { setBusy(true); try { onSaved(await reEnableAlarm("kasvamo", sig!) as KasvamoAlarms); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }}>Päälle nyt</button>
            </div>)}
          {!f.enabled && L?.enabled !== false && <DisableDuration value={disMin} onChange={setDisMin} />}
          <div className="grid grid-cols-3 gap-2">
            <label>Alaraja<input className={inp} value={f.lo} placeholder="ei" onChange={(e) => setF({ ...f, lo: e.target.value })} /></label>
            <label>Yläraja<input className={inp} value={f.hi} placeholder="ei" onChange={(e) => setF({ ...f, hi: e.target.value })} /></label>
            <label>Hystereesi<input className={inp} value={f.hyst} onChange={(e) => setF({ ...f, hyst: e.target.value })} /></label>
          </div>
          <label className="block">Viive (min, kaikki signaalit)<input className={inp} value={f.delay} onChange={(e) => setF({ ...f, delay: e.target.value })} /></label>
          <div className="text-xs text-muted-foreground">Tyhjä = ei rajaa. Sallittu {S?.range[0]}–{S?.range[1]}. Ilmoitus Valvomo-bottiin kerran alkaessa ja palautuessa. Vain Myko-asetus, ei PLC-kirjoitusta.</div>
          {err && <div className="text-xs text-red-500">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button className="rounded border border-border px-3 py-1" onClick={onClose}>Peruuta</button>
            <button className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={busy} onClick={save}>{busy ? "Tallennetaan…" : "Tallenna"}</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useLive() {
  const [vals, setVals] = useState<Partial<Record<TagName, DataloggerLatest>>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const rows = await getDataloggerLatest(Object.values(TAGS));
        if (!alive) return;
        const out: Partial<Record<TagName, DataloggerLatest>> = {};
        for (const [name, key] of Object.entries(TAGS)) {
          const r = rows.find((x) => x.variableKey === key);
          if (r) out[name as TagName] = r;
        }
        setVals(out);
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { vals, err };
}

const C = {
  bg: "#0f172a",
  panel: "#1e293b",
  stroke: "#334155",
  pipe: "#3b82f6",
  pipeOff: "#475569",
  water: "#38bdf8",
  text: "#e2e8f0",
  muted: "#64748b",
  on: "#22c55e",
  off: "#ef4444",
  na: "#475569",
};

function fmt(v: number | null | undefined, d: number) {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);
}

const ACCENT = "#f59e0b";
type BoxState = "alarm" | "alarmAck" | "warning" | undefined;
function ValueBox({ x, y, w = 92, h = 40, label, value, unit, wired = true, title, onClick, selected = false, alarm = false, state, limits, clickHint }: {
  x: number; y: number; w?: number; h?: number; label: string; value?: string; unit?: string; wired?: boolean; title?: string;
  onClick?: () => void; selected?: boolean; alarm?: boolean; state?: BoxState; limits?: string; clickHint?: string;
}) {
  const st: BoxState = state ?? (alarm ? "alarm" : undefined);
  // kuittaamaton hälytys = punasävy + punainen kehys; kuitattu = vain punainen kehys; varoitus = oranssi kehys
  const fill = st === "alarm" ? "#4a1d22" : C.panel;
  const stroke = st === "alarm" || st === "alarmAck" ? "#ef4444" : st === "warning" ? "#f59e0b" : selected ? ACCENT : wired ? C.stroke : C.na;
  const labelY = Math.min(14, Math.max(10, h * 0.35));
  const valueY = Math.max(labelY + 12, h - 8);
  return (
    <g transform={`translate(${x},${y})`} opacity={wired ? 1 : 0.55} onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined} role={onClick ? "button" : undefined}
      data-testid={onClick ? `pd-click-${label}` : undefined}>
      <title>{(title ?? label) + (onClick ? (clickHint ?? " – avaa G_Air-säädin") : "")}</title>
      <rect width={w} height={h} rx={6} fill={fill} stroke={stroke} strokeWidth={selected || st ? 2.5 : 1} data-state={st ?? ""} strokeDasharray={wired ? undefined : "4 3"} />
      {limits && <text x={w - 6} y={labelY} textAnchor="end" fontSize={8} fill={st === "alarm" ? "#fecaca" : C.muted} fontFamily="monospace">{limits}</text>}
      {selected && (
        <g transform={`translate(${w - 26},-7)`}>
          <rect width={26} height={14} rx={4} fill={ACCENT} />
          <text x={13} y={10.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#111" fontFamily="monospace">PID</text>
        </g>
      )}
      <text x={8} y={labelY} fontSize={9} fill={C.muted} fontFamily="monospace">{label}</text>
      <text x={8} y={valueY} fontSize={wired ? 15 : 10} fill={wired ? C.text : C.muted} fontFamily="monospace" fontWeight={600}>
        {wired ? `${value ?? "—"}${unit ? ` ${unit}` : ""}` : "ei kytketty"}
      </text>
    </g>
  );
}

// state: true/false = ON/OFF, undefined = unwired
function Pump({ x, y, label, state, color = C.pipe, status, enable, detail, writeAllowed, busy, onToggle }: {
  x: number; y: number; label: string; state?: boolean; color?: string;
  status?: string; enable?: boolean; detail?: string;
  writeAllowed?: boolean; busy?: boolean; onToggle?: (en: boolean) => void;
}) {
  const wired = state !== undefined || enable !== undefined;
  const on = state === true;
  const stroke = state === undefined ? C.na : on ? color : C.pipeOff;
  const canToggle = enable !== undefined && !!writeAllowed && !busy && !!onToggle;
  return (
    <g transform={`translate(${x} ${y})`} data-testid={`pump-${label}`}>
      <title>{detail ?? (wired ? `${label}: ${on ? "KÄY" : "seis"}` : `${label}: ei kytketty`)}</title>
      <circle r={16} fill={C.panel} stroke={stroke} strokeWidth={3} />
      <path d="M -6 0 L 6 -8 L 6 8 Z" fill={on ? color : C.na} opacity={0.9} />
      <text y={28} textAnchor="middle" fill={C.text} fontSize={10} fontFamily="ui-monospace, monospace">{label}</text>
      {status && <text y={40} textAnchor="middle" fill={status === "VIKA" ? "#f87171" : status === "KÄY" ? "#34d399" : "#94a3b8"} fontSize={9} fontFamily="ui-monospace, monospace">{status}{enable === false ? " · OFF" : enable === true ? " · ON" : ""}</text>}
      {enable !== undefined && (
        <g transform={`translate(-22, ${status ? 46 : 34})`} style={canToggle ? { cursor: "pointer" } : undefined}
          opacity={canToggle ? 1 : 0.45}
          onClick={canToggle ? (e) => { e.stopPropagation(); onToggle!(!enable); } : undefined}
          role={canToggle ? "button" : undefined}
          data-testid={`pump-en-${label}`}>
          <rect width={44} height={16} rx={8} fill={enable ? C.on : "#3f3f46"} stroke={C.stroke} />
          <text x={22} y={12} textAnchor="middle" fontSize={9} fill="#fff" fontFamily="monospace" fontWeight={700}>
            {busy ? "…" : enable ? "Off" : "On"}
          </text>
        </g>
      )}
    </g>
  );
}

/** Lannoitepumppu (Pumput.FertDose): yksi symboli (2 fyysistä samaan lähtöön). Lähtö KÄY/seis, vika, Käyttö On/Off. */
function FertPump({ x, y, pump, enable, fault, faultText, writeAllowed, busy, onToggle }: {
  x: number; y: number; pump?: boolean; enable?: boolean; fault?: boolean; faultText?: string;
  writeAllowed?: boolean; busy?: boolean; onToggle?: (en: boolean) => void;
}) {
  const wired = pump !== undefined;
  const run = !!pump;
  const fill = !wired ? C.na : run ? C.on : C.off;
  const stroke = fault ? C.off : wired ? C.pipe : C.na;
  const canToggle = wired && enable !== undefined && !!writeAllowed && !busy && !!onToggle;
  return (
    <g transform={`translate(${x},${y})`} opacity={wired ? 1 : 0.6} data-testid="pd-fert-pump">
      <title>{wired
        ? `Lannoitepumppu: lähtö ${run ? "KÄY" : "seis"}, käyttö ${enable ? "ON" : "OFF"}${fault ? ` · VIKA ${faultText ?? ""}` : ""} · Pumput.FertDose.Pump / Enable`
        : "Lannoitepumppu (Pumput.FertDose): ei kytketty"}</title>
      <circle r={16} fill={C.panel} stroke={stroke} strokeWidth={3} />
      <path d="M -7 -8 L 9 0 L -7 8 Z" fill={wired ? (fault ? C.off : C.pipe) : C.na}>
        {wired && run && <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s" repeatCount="indefinite" />}
      </path>
      <text y={32} textAnchor="middle" fontSize={10} fill={C.text} fontFamily="monospace">Lannoite</text>
      <rect x={-28} y={38} width={56} height={16} rx={8} fill={fill} />
      <text y={50} textAnchor="middle" fontSize={9} fill="#fff" fontFamily="monospace" fontWeight={700}>
        {!wired ? "ei kytk." : run ? "KÄY" : "seis"}
      </text>
      {fault && (
        <g>
          <rect x={-28} y={56} width={56} height={14} rx={4} fill="#7f1d1d" stroke={C.off} />
          <text y={66} textAnchor="middle" fontSize={8} fill="#fecaca" fontFamily="monospace" fontWeight={700}>VIKA</text>
        </g>
      )}
      <g transform={`translate(0, ${fault ? 78 : 60})`}>
        <text y={0} textAnchor="middle" fontSize={8} fill={C.muted} fontFamily="monospace">
          Käyttö {enable === undefined ? "—" : enable ? "ON" : "OFF"}
        </text>
        <g transform="translate(-22, 6)" style={canToggle ? { cursor: "pointer" } : undefined}
          opacity={canToggle ? 1 : 0.45}
          onClick={canToggle ? (e) => { e.stopPropagation(); onToggle!(!enable); } : undefined}
          role={canToggle ? "button" : undefined}
          data-testid="pd-fert-enable">
          <rect width={44} height={16} rx={8} fill={enable ? C.on : "#3f3f46"} stroke={C.stroke} />
          <text x={22} y={12} textAnchor="middle" fontSize={9} fill="#fff" fontFamily="monospace" fontWeight={700}>
            {busy ? "…" : enable ? "Off" : "On"}
          </text>
        </g>
      </g>
    </g>
  );
}

function Tank({ x, y, w, h, level, label, sub }: { x: number; y: number; w: number; h: number; level?: number | null; label: string; sub?: string }) {
  const wired = level !== undefined;
  const pct = Math.max(0, Math.min(100, Number(level ?? 0)));
  const lh = (h * pct) / 100;
  const id = `clip-${label.replace(/\W/g, "")}`;
  return (
    <g transform={`translate(${x},${y})`}>
      <defs>
        <clipPath id={id}><rect width={w} height={h} rx={10} /></clipPath>
        <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={C.water} stopOpacity={0.9} />
          <stop offset="1" stopColor="#0369a1" stopOpacity={0.9} />
        </linearGradient>
      </defs>
      <rect width={w} height={h} rx={10} fill="#0b1220" stroke={C.stroke} strokeWidth={2} />
      {wired && (
        <g clipPath={`url(#${id})`}>
          <rect x={0} width={w} y={h - lh} height={lh} fill={`url(#${id}-g)`} style={{ transition: "all 1s ease" }} />
          <path d={`M0 ${h - lh} q ${w / 4} -5 ${w / 2} 0 t ${w / 2} 0 v 6 h ${-w} z`} fill={C.water} opacity={0.6} style={{ transition: "all 1s ease" }}>
            <animateTransform attributeName="transform" type="translate" values={`0 0; ${-w / 8} 0; 0 0`} dur="3s" repeatCount="indefinite" />
          </path>
        </g>
      )}
      <text x={w / 2} y={-8} textAnchor="middle" fontSize={11} fill={C.text} fontFamily="monospace">{label}</text>
      {sub && <text x={w / 2} y={h + 14} textAnchor="middle" fontSize={9} fill={C.muted} fontFamily="monospace">{sub}</text>}
    </g>
  );
}

function Btn({ x, y, w, h = 26, label, badge, badgeColor, title }: { x: number; y: number; w: number; h?: number; label: string; badge?: string; badgeColor?: string; title?: string }) {
  const wired = !!title;
  return (
    <g transform={`translate(${x},${y})`} opacity={wired ? 1 : 0.5}>
      <title>{title ?? `${label}: ei kytketty (vain näyttö)`}</title>
      <rect width={w} height={h} rx={5} fill={C.panel} stroke={wired ? C.stroke : C.na} strokeDasharray={wired ? undefined : "4 3"} />
      <text x={w / 2} y={h * 0.65} textAnchor="middle" fontSize={11} fill={wired ? C.text : C.muted} fontFamily="monospace">{label}</text>
      {badge !== undefined && (
        <g transform={`translate(${w - 4},-4)`}>
          <circle r={9} fill={badgeColor ?? C.na} />
          <text y={3} textAnchor="middle" fontSize={8} fill="#fff" fontFamily="monospace">{badge}</text>
        </g>
      )}
    </g>
  );
}

function Pipe({ d, active = false }: { d: string; active?: boolean }) {
  return (
    <g>
      <path d={d} fill="none" stroke={active ? C.pipe : C.pipeOff} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
      {active && (
        <path d={d} fill="none" stroke="#bfdbfe" strokeWidth={2} strokeDasharray="6 10" strokeLinecap="round">
          <animate attributeName="stroke-dashoffset" from="32" to="0" dur="1.2s" repeatCount="indefinite" />
        </path>
      )}
    </g>
  );
}


/** Drag + SE-corner resize for Prosessikuva element boxes (edit mode only). */
function EditableBox({
  id, box, editing, svgRef, onChange, children,
}: {
  id: string;
  box: ProcessBox;
  editing: boolean;
  svgRef: RefObject<SVGSVGElement | null>;
  onChange: (id: string, next: ProcessBox) => void;
  children: ReactNode;
}) {
  const startPtr = (mode: "move" | "resize") => (e: ReactPointerEvent) => {
    if (!editing || !svgRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    const svg = svgRef.current;
    const origin = clientToSvg(svg, e.clientX, e.clientY);
    const start = { ...box };
    const move = (ev: PointerEvent) => {
      const pt = clientToSvg(svg, ev.clientX, ev.clientY);
      const dx = pt.x - origin.x;
      const dy = pt.y - origin.y;
      if (mode === "move") onChange(id, clampBox({ ...start, x: start.x + dx, y: start.y + dy }));
      else onChange(id, clampBox({ ...start, w: start.w + dx, h: start.h + dy }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  if (!editing) return <>{children}</>;

  return (
    <g data-edit-id={id} data-testid={`pd-edit-${id}`} style={{ touchAction: "none" }}>
      <g onPointerDown={startPtr("move")} style={{ cursor: "move" }}>
        {children}
      </g>
      <rect
        x={box.x} y={box.y} width={box.w} height={box.h}
        fill="transparent" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="3 2" opacity={0.85}
        pointerEvents="none"
      />
      <rect
        x={box.x + box.w - 12} y={box.y + box.h - 12} width={12} height={12}
        fill="#38bdf8" stroke="#0ea5e9" strokeWidth={1} rx={2}
        style={{ cursor: "nwse-resize" }}
        onPointerDown={startPtr("resize")}
        data-testid={`pd-resize-${id}`}
      >
        <title>Muuta kokoa</title>
      </rect>
    </g>
  );
}

function useProcessBoxEdit() {
  const [boxes, setBoxes] = useState<ProcessBoxMap>(() => mergeProcessBoxes(null));
  const [saved, setSaved] = useState<ProcessBoxMap>(() => mergeProcessBoxes(null));
  const [zoom, setZoom] = useState<ProcessZoom>(() => ({ ...DEFAULT_PROCESS_ZOOM }));
  const [savedZoom, setSavedZoom] = useState<ProcessZoom>(() => ({ ...DEFAULT_PROCESS_ZOOM }));
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [fitScale, setFitScale] = useState(1);

  useEffect(() => {
    loadProcessLayout()
      .then((s) => {
        setBoxes(s.boxes); setSaved(s.boxes);
        setZoom(s.zoom); setSavedZoom(s.zoom);
      })
      .catch(() => undefined);
  }, []);

  // Measure widget viewport → fit scale so 960×580 never clips by default.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      const s = Math.min(w / PROCESS_VIEW_W, h / PROCESS_VIEW_H);
      setFitScale(Number.isFinite(s) && s > 0 ? Math.min(4, s) : 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onChange = useCallback((id: string, next: ProcessBox) => {
    setBoxes((prev) => ({ ...prev, [id]: next }));
    setDirty(true);
  }, []);

  const setZoomUser = useCallback((next: ProcessZoom | ((z: ProcessZoom) => ProcessZoom)) => {
    setZoom((prev) => clampProcessZoom(typeof next === "function" ? next(prev) : next));
    setDirty(true);
  }, []);

  const box = (id: string): ProcessBox => boxes[id] ?? DEFAULT_PROCESS_BOXES[id];

  /** Effective CSS scale applied to the SVG. */
  const effectiveScale = zoom.scale == null ? fitScale : zoom.scale;

  const save = async () => {
    try {
      const s = await saveProcessLayout(boxes, zoom);
      setBoxes(s.boxes); setSaved(s.boxes);
      setZoom(s.zoom); setSavedZoom(s.zoom);
      setDirty(false); setEditing(false);
      toast.success("Elementtien asettelu tallennettu");
    } catch (e) { toast.error((e as Error).message); }
  };
  const cancel = () => {
    setBoxes(saved); setZoom(savedZoom); setDirty(false); setEditing(false);
  };
  const reset = async () => {
    if (!confirm("Palautetaanko prosessikuvan elementtien oletuskoot, -paikat ja zoom?")) return;
    try {
      const s = await resetProcessLayout();
      setBoxes(s.boxes); setSaved(s.boxes);
      setZoom(s.zoom); setSavedZoom(s.zoom);
      setDirty(false); setEditing(false);
      toast.success("Oletusasettelu palautettu");
    } catch (e) { toast.error((e as Error).message); }
  };

  return {
    boxes, box, editing, setEditing, dirty, svgRef, viewportRef,
    onChange, save, cancel, reset,
    zoom, setZoomUser, effectiveScale, fitScale,
  };
}


export function ProcessDiagramWidget() {
  const { vals, err } = useLive();
  const [fpOpen, setFpOpen] = useState(false);
  const pid = usePid("G_Air", fpOpen ? 2000 : 5000);
  const [pvDl, setPvDl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getPvFeed("G_Air").then((d) => {
      if (!alive) return;
      const f = d.feed;
      setPvDl(d.sources?.find((s) => s.topic === f.topic && s.field === f.field)?.dl ?? null);
    }).catch(() => undefined);
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [fpOpen]);
  const openFp = () => setFpOpen(true);
  const pv = pid.v;
  const v = (k: TagName) => vals[k]?.value ?? null;
  const ts = vals.level?.timestamp ?? vals.ec?.timestamp;
  const fan = v("fan");
  const pu = usePumput();
  const seq = useSequence();
  const ka = useKasAlarms(); const fd = useFertDose(); const [alSig, setAlSig] = useState<string | null>(null); const [ecDlg, setEcDlg] = useState(false);
  const [fertBusy, setFertBusy] = useState(false);
  const [circBusy, setCircBusy] = useState<"L" | "R" | null>(null);
  const pe = useProcessBoxEdit();
  const toggleFert = async (en: boolean) => {
    if (!window.confirm(`Vahvista: lannoitepumppu Käyttö → ${en ? "ON" : "OFF"}?`)) return;
    setFertBusy(true);
    try {
      const r = await setFertPumpEnable(en);
      toast.success(r.interlock ? `Lannoite Käyttö ${en ? "ON" : "OFF"} (EC-lukitus pitää Enable OFF)` : `Lannoite Käyttö: ${en ? "ON" : "OFF"}`);
      fd.load();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setFertBusy(false); }
  };
  const toggleCirc = async (sd: "L" | "R", en: boolean) => {
    const name = sd === "L" ? "vasen" : "oikea";
    if (!window.confirm(`Vahvista: kiertopumppu ${name} → ${en ? "KÄYTTÖÖN" : "POIS KÄYTÖSTÄ"}?`)) return;
    setCircBusy(sd);
    try {
      await setCircPumpEnable(sd, en);
      toast.success(`Kiertopumppu ${name}: ${en ? "käytössä" : "pois"}`);
      seq.load();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setCircBusy(null); }
  };
  const fp = fd.d?.plc;
  const fertLive = !!(fp?.present && fp?.fresh !== false && (fp?.Pump !== undefined || fp?.Enable !== undefined));
  const sqLive = !!seq.d?.present;
  const sq = (seq.d?.plc ?? {}) as Record<string, unknown>;
  const circ = (sd: "L" | "R") => {
    const run = sqLive ? sq[`${sd}_Running`] === true || sq[`${sd}_Pump`] === true : pu.b(sd === "L" ? "Circulation_L" : "Circulation_R");
    const err = sqLive ? sq[`${sd}_Error`] === true : false;
    const wait = sqLive ? sq[`${sd}_Waiting`] === true : false;
    const en = sqLive ? (sq[`${sd}_Enable`] as boolean | undefined) : undefined;
    const errCode = sqLive ? (sq[`${sd}_ErrCode`] as number | undefined) : undefined;
    const rt = sqLive ? (sq[`${sd}_RunTime_ms`] as number | undefined) : undefined;
    const starts = sqLive ? (sq[`${sd}_StartCount`] as number | undefined) : undefined;
    let label = "seis";
    if (err) label = "VIKA";
    else if (en === false) label = "OFF";
    else if (wait) label = "odot";
    else if (run) label = "KÄY";
    return { run: !!run, err, wait, en, errCode, rt, starts, label, wired: sqLive || pu.ok };
  };
  const cL = circ("L"); const cR = circ("R");
  const seqStep = sqLive ? (sq.Step as number | undefined) : undefined;
  const seqLevel = sqLive && typeof sq.Level === "number" ? (sq.Level as number) : undefined;

  const fertIlok = (fp as { Interlock?: boolean } | undefined)?.Interlock;
  const fertFault = fertLive && (fp!.HB_OK === false || fertIlok === false || (typeof fp!.Status === "number" && [4,5,6,7,8,9,10,11,13,14,15].includes(fp!.Status)));
  const fertFaultTxt = !fertLive ? undefined : fp!.HB_OK === false ? "HB" : fertIlok === false ? "interlock" : (fp!.statusText ?? `Status ${fp!.Status}`);
  const kState = (k: string): BoxState => { const ks = [`${k}:lo`, `${k}:hi`].filter((x) => ka.a?.active[x]); return !ks.length ? undefined : ks.some((x) => !ka.a?.acked?.[x]) ? "alarm" : "alarmAck"; };
  const ecEv = (fd.d?.active ?? []).filter((e) => e.code?.startsWith("ec_"));
  const ecState: BoxState = ecEv.some((e) => e.level === "alarm" && !e.acked) ? "alarm" : ecEv.some((e) => e.level === "alarm") ? "alarmAck" : ecEv.length ? "warning" : undefined;
  const kp = (k: string) => ({ onClick: () => setAlSig(k), clickHint: " – muokkaa hälytysrajoja", state: kState(k), limits: limTxt(ka.a?.config.limits[k]) });
  const alarms = [["A_HumHH", "Kosteus HH"], ["A_Tayttovesi", "Täyttövesi"], ["EC_Below_Q", "EC alhainen (EC_Below)"]].filter(([k]) => pu.b(k));
  const fet = pu.n("FillingOnTime_ET");
  const tmr = fet !== undefined ? `${Math.round(fet / 1000)} s` : undefined;

  return (
    <>
      <AlarmDialog sig={alSig} data={ka.a} onClose={() => setAlSig(null)} onSaved={ka.setA} />
      <MeasurementPointWidget config={{ pointId: "GardenAir", name: "Kasvamo ilma · G_Air (PF-1)" }} open={fpOpen} onOpenChange={setFpOpen} dialogOnly />
      <FertEcModal open={ecDlg} d={fd.d} reload={fd.load} onClose={() => setEcDlg(false)} />
      <div className="flex h-full min-h-0 flex-col gap-1 overflow-hidden p-1" data-testid="pd-process">
        <div className="shrink-0 text-[10px] font-mono text-muted-foreground" data-testid="pd-status">
          {err ? `Virhe: ${err}` : ts ? `Päivitetty ${new Date(ts).toLocaleTimeString("fi-FI")}` : "Ladataan…"} · {POLL_MS / 1000} s · vain luku{sqLive ? ` · Seq askel ${seqStep ?? "–"} · taso ${seqLevel != null ? seqLevel.toFixed(1) : "–"}` : ""}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2" data-testid="pd-elem-toolbar">
          {!pe.editing ? (
            <Button size="sm" variant="outline" onClick={() => pe.setEditing(true)} data-testid="pd-elem-edit">
              <Pencil className="mr-1 h-3 w-3" /> Muokkaa elementtejä
            </Button>
          ) : (
            <>
              <span className="mr-auto text-[11px] font-mono text-sky-300">Vedä · kokoa · zoom</span>
              <div className="flex flex-wrap items-center gap-1 rounded border border-border/60 bg-secondary/30 px-1.5 py-0.5" data-testid="pd-zoom-controls" onMouseDown={(e) => e.stopPropagation()}>
                <button type="button" className="p-1 text-muted-foreground hover:text-foreground" title="Pienennä" data-testid="pd-zoom-out"
                  onClick={() => pe.setZoomUser((z) => ({ ...z, scale: Math.max(0.15, Math.round(((z.scale ?? pe.fitScale) * 0.9) * 100) / 100) }))}>
                  <Minus className="h-3 w-3" />
                </button>
                <input
                  type="range" min={15} max={250} step={1}
                  aria-label="Zoom"
                  data-testid="pd-zoom-slider"
                  className="h-1.5 w-24 cursor-pointer accent-sky-400"
                  value={Math.round((pe.zoom.scale ?? pe.fitScale) * 100)}
                  onChange={(e) => pe.setZoomUser((z) => ({ ...z, scale: Math.max(0.15, Number(e.target.value) / 100) }))}
                />
                <button type="button" className="p-1 text-muted-foreground hover:text-foreground" title="Suurenna" data-testid="pd-zoom-in"
                  onClick={() => pe.setZoomUser((z) => ({ ...z, scale: Math.min(4, Math.round(((z.scale ?? pe.fitScale) * 1.1) * 100) / 100) }))}>
                  <Plus className="h-3 w-3" />
                </button>
                <span className="min-w-[2.75rem] text-center font-mono text-[10px] text-muted-foreground" data-testid="pd-zoom-pct">
                  {pe.zoom.scale == null ? "Sovita" : `${Math.round(pe.zoom.scale * 100)}%`}
                </span>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" data-testid="pd-zoom-fit"
                  onClick={() => pe.setZoomUser({ scale: null, panX: 0, panY: 0 })}>Sovita</Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" data-testid="pd-zoom-100"
                  onClick={() => pe.setZoomUser({ scale: 1, panX: 0, panY: 0 })}>100%</Button>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void pe.reset()} data-testid="pd-elem-default"><RotateCcw className="mr-1 h-3 w-3" /> Default</Button>
              <Button size="sm" variant="ghost" onClick={pe.cancel}>Cancel</Button>
              <Button size="sm" onClick={() => void pe.save()} disabled={!pe.dirty} data-testid="pd-elem-save"><Save className="mr-1 h-3 w-3" /> Save</Button>
            </>
          )}
        </div>
        <div ref={pe.viewportRef} className="relative min-h-0 flex-1 overflow-hidden" data-testid="pd-viewport">
        <div
          className="origin-top-left"
          style={{
            width: PROCESS_VIEW_W,
            height: PROCESS_VIEW_H,
            transform: `translate(${pe.zoom.panX}px, ${pe.zoom.panY}px) scale(${pe.effectiveScale})`,
          }}
          data-testid="pd-zoom-layer"
        >
        <svg ref={pe.svgRef} viewBox={`0 0 ${PROCESS_VIEW_W} ${PROCESS_VIEW_H}`} width={PROCESS_VIEW_W} height={PROCESS_VIEW_H} style={{ background: C.bg, borderRadius: 8, display: "block" }}>
          {/* Air duct + fan */}
          <Pipe d="M 560 70 H 700" active={(fan ?? 0) > 0} />
          <Pipe d="M 780 70 H 870 Q 900 70 900 40" active={(fan ?? 0) > 0} />
          <g transform="translate(740,70)" onClick={openFp} style={{ cursor: "pointer" }} data-testid="pd-fan">
            <title>Tuuletin PF-1 – avaa G_Air-säädin</title>
            <circle r={30} fill={C.panel} stroke={C.stroke} strokeWidth={3} />
            <g>
              {[0, 120, 240].map((a) => (
                <path key={a} d="M0 0 Q 8 -20 0 -24 Q -8 -20 0 0" fill={C.water} transform={`rotate(${a})`} />
              ))}
              {(fan ?? 0) > 0 && (
                <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur={`${Math.max(0.4, 3 - (fan ?? 0) / 40)}s`} repeatCount="indefinite" />
              )}
            </g>
            <circle r={4} fill={C.text} />
          </g>
          <EditableBox id="vb-fan" box={pe.box("vb-fan")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-fan")} label="Tuuletin PF-1" value={fmt(fan, 1)} unit="%" title={`${TAGS.fan} PF-1 %`} onClick={pe.editing ? undefined : openFp} />
          </EditableBox>
          <EditableBox id="vb-duct" box={pe.box("vb-duct")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-duct")} label="Poistoilma" value={fmt(v("ductTemp"), 1)} unit="°C" title={`${TAGS.ductTemp} G Poistoilma DS4`} onClick={pe.editing ? undefined : openFp} selected={pvDl === TAGS.ductTemp} />
          </EditableBox>

          {/* G_Air PID summary (click -> faceplate) */}
          <EditableBox id="pid-gair" box={pe.box("pid-gair")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <g transform={`translate(${pe.box("pid-gair").x},${pe.box("pid-gair").y})`} onClick={pe.editing ? undefined : openFp} style={{ cursor: pe.editing ? "move" : "pointer" }} data-testid="pd-gair">
              <title>G_Air PID (PF-1) – avaa säädin</title>
              <rect width={pe.box("pid-gair").w} height={pe.box("pid-gair").h} rx={6} fill={C.panel} stroke={ACCENT} strokeWidth={1.5} />
              <rect x={6} y={6} width={30} height={14} rx={4} fill={ACCENT} />
              <text x={21} y={16.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#111" fontFamily="monospace">PID</text>
              <text x={42} y={17} fontSize={9} fill={C.muted} fontFamily="monospace">
                G_Air · {pid.stale ? "ei dataa" : (PID_STATE?.[pv?.State ?? -1] ?? `State ${pv?.State ?? "—"}`)}{pv?.ErrBits ? ` · ErrBits 16#${pv.ErrBits.toString(16).toUpperCase().padStart(4, "0")}` : ""}
              </text>
              <text x={8} y={Math.max(28, pe.box("pid-gair").h - 8)} fontSize={13} fontWeight={600} fill={C.text} fontFamily="monospace">
                PV {fmt(pv?.PV, 1)} · SP {fmt(pv?.SP, 1)} °C · {fmt(pv?.OutSum, 0)} %
              </text>
            </g>
          </EditableBox>

          {/* Air temps */}
          <EditableBox id="vb-roof" box={pe.box("vb-roof")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-roof")} label="Katto" value={fmt(v("roofTemp"), 1)} unit="°C" title={`${TAGS.roofTemp} G Katto DS3`} onClick={pe.editing ? undefined : openFp} selected={pvDl === TAGS.roofTemp} />
          </EditableBox>
          <EditableBox id="vb-mid" box={pe.box("vb-mid")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-mid")} label="Keskiosa" value={fmt(v("midTemp"), 1)} unit="°C" title={`${TAGS.midTemp} G Mid DS2`} onClick={pe.editing ? undefined : openFp} selected={pvDl === TAGS.midTemp} />
          </EditableBox>

          {/* Top bar buttons (HMI) */}
          <EditableBox id="btn-halytykset" box={pe.box("btn-halytykset")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <Btn {...pe.box("btn-halytykset")} label="Hälytykset" badge={pu.ok ? String(alarms.length) : "?"} badgeColor={pu.ok ? (alarms.length ? C.off : C.on) : undefined}
              title={pu.ok ? `Pumput_DB-hälytykset: ${alarms.length ? alarms.map((a) => a[1]).join(", ") : "ei aktiivisia"} (A_HumHH.Active, Tayttovesi.Active, EC_Below.Q)` : undefined} />
          </EditableBox>

          {/* Pipes */}
          <Pipe d="M 60 360 V 260 H 300 V 320" active={cL.run} />
          <Pipe d="M 160 420 V 350 H 330" active={fertLive && fp?.Pump === true} />
          <Pipe d="M 360 320 V 230 H 800 V 360" active={pu.b("Filling")} />
          <Pipe d="M 400 320 V 270 H 690 V 360" active={cR.run} />

          {/* Main tank */}
          <Tank x={300} y={320} w={130} h={200} level={v("level")} label="Ravinnesäiliö" />
          <EditableBox id="vb-pinta" box={pe.box("vb-pinta")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-pinta")} label="Pinta" value={fmt(v("level"), 1)} unit="%" title={`${TAGS.level} Level · PLC SP ${pu.n("LVL_SP") ?? "—"} %`} {...kp("pinta")} onClick={pe.editing ? undefined : kp("pinta").onClick} />
          </EditableBox>
          <EditableBox id="vb-vesi" box={pe.box("vb-vesi")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-vesi")} label="Vesi" value={fmt(v("waterTemp"), 1)} unit="°C" title={`${TAGS.waterTemp} Water Temp`} {...kp("vesi")} onClick={pe.editing ? undefined : kp("vesi").onClick} />
          </EditableBox>
          <EditableBox id="vb-ec" box={pe.box("vb-ec")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-ec")} label="EC" value={fmt(v("ec"), 0)} unit="ppm" title={`${TAGS.ec} ppm · PLC TDS_SP ${pu.n("TDS_SP") ?? "—"}`} {...kp("ec")} onClick={pe.editing ? undefined : () => setEcDlg(true)} state={ecState} limits={fd.d?.config.ec_alarm ? (fd.d.config.ec_alarm.enabled ? `SP${fd.d.config.ec_alarm.lo_off}/+${fd.d.config.ec_alarm.hi_off}` : "pois") : undefined} />
          </EditableBox>
          <EditableBox id="vb-ph" box={pe.box("vb-ph")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-ph")} label="pH" value={fmt(v("ph"), 2)} title={`${TAGS.ph} pH`} {...kp("ph")} onClick={pe.editing ? undefined : kp("ph").onClick} />
          </EditableBox>
          <g opacity={0.55}>
            <title>Lämmitin: ei kytketty</title>
            <rect x={300} y={530} width={130} height={14} rx={3} fill={C.na} />
            <text x={365} y={541} textAnchor="middle" fontSize={9} fill="#fff" fontFamily="monospace">Lämmitin – ei kytketty</text>
          </g>

          {/* G1 temp + timer */}
          <EditableBox id="vb-g1" box={pe.box("vb-g1")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-g1")} label="G1 lämpötila" value={fmt(v("g1Temp"), 1)} unit="°C" title={`${TAGS.g1Temp} G1 temp TT`} />
          </EditableBox>
          <EditableBox id="vb-ajastin" box={pe.box("vb-ajastin")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-ajastin")} label="Ajastin" wired={!!tmr} value={tmr} title={`Pumput_DB FillingOnTime.ET / PT ${Math.round((pu.n("FillingOnTime_PT") ?? 0) / 1000)} s · kiertoajastin Työ ${pu.n("OnTime") ?? "—"} s / Tauko ${pu.n("OffTime") ?? "—"} s (${pu.b("Tyo_IN") ? "työ" : "tauko"} ${Math.round(((pu.b("Tyo_IN") ? pu.n("Tyo_ET") : pu.n("Tauko_ET")) ?? 0) / 1000)} s)`} />
          </EditableBox>
          <EditableBox id="vb-kosteus" box={pe.box("vb-kosteus")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-kosteus")} label="Kosteus" wired={pu.n("G_Hum") !== undefined} value={fmt(pu.n("G_Hum"), 1)} unit="%" title={`Pumput_DB G_Hum (HH-raja ${pu.n("HumHH_SP") ?? "—"} %)`} />
          </EditableBox>

          {/* Left: water tank + pumps */}
          <Tank x={20} y={420} w={90} h={100} label="L" sub="pinta ei kytketty" />
          <Pump x={60} y={330} label="Pumppu L" state={cL.run} status={cL.wired ? cL.label : undefined} enable={cL.en}
            writeAllowed={!!seq.d?.pump_write_allowed} busy={circBusy === "L"} onToggle={(en) => void toggleCirc("L", en)}
            detail={cL.wired ? `CircPump_L: ${cL.label}, Enable ${cL.en ?? "–"}, ErrCode ${cL.errCode ?? 0}, käynti ${cL.rt != null ? Math.round(cL.rt/1000)+" s" : "–"}, käynnistyksiä ${cL.starts ?? "–"}` : "Pumppu L: ei CircPump-dataa"} />
          <FertPump x={160} y={410}
            pump={fertLive ? fp?.Pump : undefined}
            enable={fertLive ? fp?.Enable : undefined}
            fault={fertFault}
            faultText={fertFaultTxt}
            writeAllowed={!!fd.d?.pump_write_allowed && !!fd.d?.config.live}
            busy={fertBusy}
            onToggle={(en) => void toggleFert(en)} />
          <Tank x={135} y={505} w={50} h={45} label="" sub="Ferts" />
          <EditableBox id="vb-lammitin-t" box={pe.box("vb-lammitin-t")} editing={pe.editing} svgRef={pe.svgRef} onChange={pe.onChange}>
            <ValueBox {...pe.box("vb-lammitin-t")} label="Lämmitin T" wired={false} />
          </EditableBox>

          {/* pH dosing */}
          <Pump x={590} y={430} label="pH+" color="#f43f5e" />
          <Pump x={670} y={430} label="pH−" color="#f43f5e" />

          {/* Right tanks */}
          <Pump x={690} y={350} label="Pumppu R" state={cR.run} status={cR.wired ? cR.label : undefined} enable={cR.en}
            writeAllowed={!!seq.d?.pump_write_allowed} busy={circBusy === "R"} onToggle={(en) => void toggleCirc("R", en)}
            detail={cR.wired ? `CircPump_R: ${cR.label}, Enable ${cR.en ?? "–"}, ErrCode ${cR.errCode ?? 0}, käynti ${cR.rt != null ? Math.round(cR.rt/1000)+" s" : "–"}, käynnistyksiä ${cR.starts ?? "–"}` : "Pumppu R: ei CircPump-dataa"} />
          <Tank x={730} y={420} w={90} h={100} label="" sub="R" />
          <Pump x={800} y={350} label="Täyttö" state={pu.b("Filling")} />
          <Tank x={840} y={420} w={90} h={100} label="" sub="Täyttövesi (Fill)" />
        </svg>
        </div>
        </div>
      </div>
    </>
  );
}

/** Compact fertiliser row + EC modal opener for dashboard widget. */
export function FertDoseWidget() {
  const fd = useFertDose();
  const [ecDlg, setEcDlg] = useState(false);
  return (
    <>
      <FertEcModal open={ecDlg} d={fd.d} reload={fd.load} onClose={() => setEcDlg(false)} />
      <FertDosePanel d={fd.d} onOpen={() => setEcDlg(true)} />
    </>
  );
}
