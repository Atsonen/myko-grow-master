import { createFileRoute } from "@tanstack/react-router";
import { DisableDuration, untilLabel, useNow, reEnableAlarm } from "@/lib/alarmDisable";
import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FertDosePanel, FertEcModal, useFertDose } from "@/components/FertDosePanel";
import { AlarmListWidget } from "@/components/dashboard/AlarmListWidget";
import { getDataloggerLatest, getKasvamoAlarms, putKasvamoAlarms, type KasvamoAlarms, type KasLimit, getPumput, getPvFeed, type DataloggerLatest, type PumputResponse } from "@/lib/apiClient";
import { DashboardDataProvider } from "@/components/dashboard/DashboardData";
import { MeasurementPointWidget } from "@/components/dashboard/MeasurementPointWidget";
import { usePid, PID_STATE } from "@/components/dashboard/PidFaceplate";

export const Route = createFileRoute("/plants/dashboard")({
  head: () => ({ meta: [{ title: "Plants dashboard - Myko Valvomo" }] }),
  component: () => (
    <DashboardDataProvider>
      <PlantsDashboardPage />
    </DashboardDataProvider>
  ),
});

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
function ValueBox({ x, y, w = 92, label, value, unit, wired = true, title, onClick, selected = false, alarm = false, state, limits, clickHint }: {
  x: number; y: number; w?: number; label: string; value?: string; unit?: string; wired?: boolean; title?: string;
  onClick?: () => void; selected?: boolean; alarm?: boolean; state?: BoxState; limits?: string; clickHint?: string;
}) {
  const st: BoxState = state ?? (alarm ? "alarm" : undefined);
  // kuittaamaton hälytys = punasävy + punainen kehys; kuitattu = vain punainen kehys; varoitus = oranssi kehys
  const fill = st === "alarm" ? "#4a1d22" : C.panel;
  const stroke = st === "alarm" || st === "alarmAck" ? "#ef4444" : st === "warning" ? "#f59e0b" : selected ? ACCENT : wired ? C.stroke : C.na;
  return (
    <g transform={`translate(${x},${y})`} opacity={wired ? 1 : 0.55} onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined} role={onClick ? "button" : undefined}
      data-testid={onClick ? `pd-click-${label}` : undefined}>
      <title>{(title ?? label) + (onClick ? (clickHint ?? " – avaa G_Air-säädin") : "")}</title>
      <rect width={w} height={40} rx={6} fill={fill} stroke={stroke} strokeWidth={selected || st ? 2.5 : 1} data-state={st ?? ""} strokeDasharray={wired ? undefined : "4 3"} />
      {limits && <text x={w - 6} y={14} textAnchor="end" fontSize={8} fill={st === "alarm" ? "#fecaca" : C.muted} fontFamily="monospace">{limits}</text>}
      {selected && (
        <g transform={`translate(${w - 26},-7)`}>
          <rect width={26} height={14} rx={4} fill={ACCENT} />
          <text x={13} y={10.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#111" fontFamily="monospace">PID</text>
        </g>
      )}
      <text x={8} y={14} fontSize={9} fill={C.muted} fontFamily="monospace">{label}</text>
      <text x={8} y={32} fontSize={wired ? 15 : 10} fill={wired ? C.text : C.muted} fontFamily="monospace" fontWeight={600}>
        {wired ? `${value ?? "—"}${unit ? ` ${unit}` : ""}` : "ei kytketty"}
      </text>
    </g>
  );
}

// state: true/false = ON/OFF, undefined = unwired
function Pump({ x, y, label, state, color = C.pipe }: { x: number; y: number; label: string; state?: boolean; color?: string }) {
  const wired = state !== undefined;
  const fill = !wired ? C.na : state ? C.on : C.off;
  return (
    <g transform={`translate(${x},${y})`} opacity={wired ? 1 : 0.6}>
      <title>{wired ? `${label}: ${state ? "PÄÄLLÄ" : "POIS"}` : `${label}: ei kytketty`}</title>
      <circle r={16} fill={C.panel} stroke={wired ? color : C.na} strokeWidth={3} />
      <path d="M -7 -8 L 9 0 L -7 8 Z" fill={wired ? color : C.na}>
        {wired && state && <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s" repeatCount="indefinite" />}
      </path>
      <text y={32} textAnchor="middle" fontSize={10} fill={C.text} fontFamily="monospace">{label}</text>
      <rect x={-22} y={38} width={44} height={16} rx={8} fill={fill} />
      <text y={50} textAnchor="middle" fontSize={9} fill="#fff" fontFamily="monospace" fontWeight={700}>
        {!wired ? "ei kytk." : state ? "ON" : "OFF"}
      </text>
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

function Btn({ x, y, w, label, badge, badgeColor, title }: { x: number; y: number; w: number; label: string; badge?: string; badgeColor?: string; title?: string }) {
  const wired = !!title;
  return (
    <g transform={`translate(${x},${y})`} opacity={wired ? 1 : 0.5}>
      <title>{title ?? `${label}: ei kytketty (vain näyttö)`}</title>
      <rect width={w} height={26} rx={5} fill={C.panel} stroke={wired ? C.stroke : C.na} strokeDasharray={wired ? undefined : "4 3"} />
      <text x={w / 2} y={17} textAnchor="middle" fontSize={11} fill={wired ? C.text : C.muted} fontFamily="monospace">{label}</text>
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

function PlantsDashboardPage() {
  const { vals, err } = useLive();
  const [fpOpen, setFpOpen] = useState(false);
  const pid = usePid("G_Air", fpOpen ? 2000 : 5000);
  const [pvDl, setPvDl] = useState<string | null>(null); // datalogger key of the selected G_Air PV source
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
  const ka = useKasAlarms(); const fd = useFertDose(); const [alSig, setAlSig] = useState<string | null>(null); const [ecDlg, setEcDlg] = useState(false);
  const kState = (k: string): BoxState => { const ks = [`${k}:lo`, `${k}:hi`].filter((x) => ka.a?.active[x]); return !ks.length ? undefined : ks.some((x) => !ka.a?.acked?.[x]) ? "alarm" : "alarmAck"; };
  const ecEv = (fd.d?.active ?? []).filter((e) => e.code?.startsWith("ec_"));
  const ecState: BoxState = ecEv.some((e) => e.level === "alarm" && !e.acked) ? "alarm" : ecEv.some((e) => e.level === "alarm") ? "alarmAck" : ecEv.length ? "warning" : undefined;
  const kp = (k: string) => ({ onClick: () => setAlSig(k), clickHint: " – muokkaa hälytysrajoja", state: kState(k), limits: limTxt(ka.a?.config.limits[k]) });
  const alarms = [["A_HumHH", "Kosteus HH"], ["A_Tayttovesi", "Täyttövesi"], ["EC_Below_Q", "EC alhainen (EC_Below)"]].filter(([k]) => pu.b(k));
  // HMI-ajastin (s) = FillingOnTime.ET (ms); HMI 5144 s ≈ ET 5 034 s luettaessa
  const fet = pu.n("FillingOnTime_ET");
  const tmr = fet !== undefined ? `${Math.round(fet / 1000)} s` : undefined;

  return (
    <div className="p-4 space-y-3 max-w-[1800px]">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-mono flex items-center gap-2">
          <Gauge className="h-4 w-4" /> Kasvamo – prosessinäkymä
        </h1>
        <span className="text-xs font-mono text-muted-foreground">
          {err ? `Virhe: ${err}` : ts ? `Päivitetty ${new Date(ts).toLocaleTimeString("fi-FI")}` : "Ladataan…"} · päivitys {POLL_MS / 1000} s · vain luku
        </span>
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-3">
      <Card className="p-2 bg-card border-border overflow-x-auto">
        <svg viewBox="0 0 960 560" className="w-full min-w-[720px]" style={{ background: C.bg, borderRadius: 8 }}>
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
          <ValueBox x={694} y={108} label="Tuuletin PF-1" value={fmt(fan, 1)} unit="%" title={`${TAGS.fan} PF-1 %`} onClick={openFp} />
          <ValueBox x={560} y={92} label="Poistoilma" value={fmt(v("ductTemp"), 1)} unit="°C" title={`${TAGS.ductTemp} G Poistoilma DS4`} onClick={openFp} selected={pvDl === TAGS.ductTemp} />

          {/* G_Air PID summary (click -> faceplate) */}
          <g transform="translate(560,160)" onClick={openFp} style={{ cursor: "pointer" }} data-testid="pd-gair">
            <title>G_Air PID (PF-1) – avaa säädin</title>
            <rect width={226} height={44} rx={6} fill={C.panel} stroke={ACCENT} strokeWidth={1.5} />
            <rect x={6} y={6} width={30} height={14} rx={4} fill={ACCENT} />
            <text x={21} y={16.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#111" fontFamily="monospace">PID</text>
            <text x={42} y={17} fontSize={9} fill={C.muted} fontFamily="monospace">
              G_Air · {pid.stale ? "ei dataa" : PID_STATE[pv?.State ?? -1] ?? `State ${pv?.State ?? "—"}`}{pv?.ErrBits ? ` · ErrBits 16#${pv.ErrBits.toString(16).toUpperCase().padStart(4, "0")}` : ""}
            </text>
            <text x={8} y={36} fontSize={13} fontWeight={600} fill={C.text} fontFamily="monospace">
              PV {fmt(pv?.PV, 1)} · SP {fmt(pv?.SP, 1)} °C · {fmt(pv?.OutSum, 0)} %
            </text>
          </g>

          {/* Air temps */}
          <ValueBox x={400} y={60} label="Katto" value={fmt(v("roofTemp"), 1)} unit="°C" title={`${TAGS.roofTemp} G Katto DS3`} onClick={openFp} selected={pvDl === TAGS.roofTemp} />
          <ValueBox x={400} y={110} label="Keskiosa" value={fmt(v("midTemp"), 1)} unit="°C" title={`${TAGS.midTemp} G Mid DS2`} onClick={openFp} selected={pvDl === TAGS.midTemp} />
          <Btn x={500} y={117} w={28} label="S" />

          {/* Top bar buttons (HMI) */}
          <Btn x={20} y={16} w={90} label="Asetukset" />
          <Btn x={118} y={16} w={50} label="EC" />
          <Btn x={176} y={16} w={50} label="PH" />
          <Btn x={20} y={50} w={28} label="S" />
          <Btn x={840} y={110} w={90} label="Hälytykset" badge={pu.ok ? String(alarms.length) : "?"} badgeColor={pu.ok ? (alarms.length ? C.off : C.on) : undefined}
            title={pu.ok ? `Pumput_DB-hälytykset: ${alarms.length ? alarms.map((a) => a[1]).join(", ") : "ei aktiivisia"} (A_HumHH.Active, Tayttovesi.Active, EC_Below.Q)` : undefined} />
          <Btn x={840} y={146} w={90} label="Kuittaus" />
          {/* yellow status bars */}
          <g opacity={0.5}>
            <title>Tilapalkki: ei kytketty</title>
            <rect x={40} y={150} width={70} height={14} rx={3} fill={C.na} />
            <rect x={770} y={196} width={70} height={14} rx={3} fill={C.na} />
            <text x={75} y={180} textAnchor="middle" fontSize={9} fill={C.muted} fontFamily="monospace">ei kytketty</text>
            <text x={805} y={224} textAnchor="middle" fontSize={9} fill={C.muted} fontFamily="monospace">ei kytketty</text>
          </g>

          {/* Pipes */}
          <Pipe d="M 60 360 V 260 H 300 V 320" active={pu.b("Circulation_L")} />
          <Pipe d="M 160 420 V 350 H 330" />
          <Pipe d="M 360 320 V 230 H 800 V 360" active={pu.b("Filling")} />
          <Pipe d="M 400 320 V 270 H 690 V 360" active={pu.b("Circulation_R")} />

          {/* Main tank */}
          <Tank x={300} y={320} w={130} h={200} level={v("level")} label="Ravinnesäiliö" />
          <ValueBox x={442} y={330} w={100} label="Pinta" value={fmt(v("level"), 1)} unit="%" title={`${TAGS.level} Level · PLC SP ${pu.n("LVL_SP") ?? "—"} %`} {...kp("pinta")} />
          <ValueBox x={442} y={376} w={100} label="Vesi" value={fmt(v("waterTemp"), 1)} unit="°C" title={`${TAGS.waterTemp} Water Temp`} {...kp("vesi")} />
          <ValueBox x={442} y={422} w={100} label="EC" value={fmt(v("ec"), 0)} unit="ppm" title={`${TAGS.ec} ppm · PLC TDS_SP ${pu.n("TDS_SP") ?? "—"}`} {...kp("ec")} onClick={() => setEcDlg(true)} state={ecState} limits={fd.d?.config.ec_alarm ? (fd.d.config.ec_alarm.enabled ? `SP${fd.d.config.ec_alarm.lo_off}/+${fd.d.config.ec_alarm.hi_off}` : "pois") : undefined} />
          <ValueBox x={442} y={468} w={100} label="pH" value={fmt(v("ph"), 2)} title={`${TAGS.ph} pH`} {...kp("ph")} />
          <g opacity={0.55}>
            <title>Lämmitin: ei kytketty</title>
            <rect x={300} y={530} width={130} height={14} rx={3} fill={C.na} />
            <text x={365} y={541} textAnchor="middle" fontSize={9} fill="#fff" fontFamily="monospace">Lämmitin – ei kytketty</text>
          </g>

          {/* G1 temp + timer */}
          <ValueBox x={560} y={280} w={100} label="G1 lämpötila" value={fmt(v("g1Temp"), 1)} unit="°C" title={`${TAGS.g1Temp} G1 temp TT`} />
          <Btn x={666} y={287} w={28} label="S" />
          <ValueBox x={560} y={226} w={100} label="Ajastin" wired={!!tmr} value={tmr} title={`Pumput_DB FillingOnTime.ET / PT ${Math.round((pu.n("FillingOnTime_PT") ?? 0) / 1000)} s · kiertoajastin Työ ${pu.n("OnTime") ?? "—"} s / Tauko ${pu.n("OffTime") ?? "—"} s (${pu.b("Tyo_IN") ? "työ" : "tauko"} ${Math.round(((pu.b("Tyo_IN") ? pu.n("Tyo_ET") : pu.n("Tauko_ET")) ?? 0) / 1000)} s)`} />
          <ValueBox x={120} y={84} w={100} label="Kosteus" wired={pu.n("G_Hum") !== undefined} value={fmt(pu.n("G_Hum"), 1)} unit="%" title={`Pumput_DB G_Hum (HH-raja ${pu.n("HumHH_SP") ?? "—"} %)`} />

          {/* Left: water tank + pumps */}
          <Tank x={20} y={420} w={90} h={100} label="L" sub="pinta ei kytketty" />
          <Pump x={60} y={330} label="Pumppu L" state={pu.b("Circulation_L")} />
          <Pump x={160} y={410} label="Lannoite" />
          <Tank x={135} y={470} w={50} h={50} label="" sub="Ferts" />
          <ValueBox x={200} y={470} w={92} label="Lämmitin T" wired={false} />

          {/* pH dosing */}
          <Pump x={590} y={430} label="pH+" color="#f43f5e" />
          <Pump x={670} y={430} label="pH−" color="#f43f5e" />

          {/* Right tanks */}
          <Pump x={690} y={350} label="Pumppu R" state={pu.b("Circulation_R")} />
          <Tank x={730} y={420} w={90} h={100} label="" sub="R" />
          <Pump x={800} y={350} label="Täyttö" state={pu.b("Filling")} />
          <Tank x={840} y={420} w={90} h={100} label="" sub="Täyttövesi (Fill)" />
        </svg>
      </Card>
      <AlarmDialog sig={alSig} data={ka.a} onClose={() => setAlSig(null)} onSaved={ka.setA} />
      <MeasurementPointWidget config={{ pointId: "GardenAir", name: "Kasvamo ilma · G_Air (PF-1)" }} open={fpOpen} onOpenChange={setFpOpen} dialogOnly />
      <FertDosePanel d={fd.d} onOpen={() => setEcDlg(true)} />
      <FertEcModal open={ecDlg} d={fd.d} reload={fd.load} onClose={() => setEcDlg(false)} />
      <div className="text-[11px] font-mono text-muted-foreground leading-relaxed">
        Harmaat katkoviivalla merkityt elementit: <b>ei kytketty</b> – signaalia ei ole tunnistettu Myko-datasta varmasti
        (lannoite, pH±, lämmittimet, vesisäiliön pinta, painikkeet). Kytketyt arvot: Datalogger {Object.values(TAGS).join(", ")};
        OPC UA Pumput_DB {pu.ok ? "" : "(ei dataa) "}– pumput L/R (Circulation_L/R), täyttö (Filling), ajastin (FillingOnTime), hälytykset, kosteus, pinta/EC-asetusarvot. Vain luku.
      </div>
      </div>
      <aside className="min-w-0 xl:sticky xl:top-2 xl:self-start" data-testid="pd-alarms">
        <Card className="flex max-h-[calc(100vh-1rem)] min-h-[420px] flex-col bg-card border-border p-2">
          <AlarmListWidget config={{ hours: 24 }} storageKey="kasvamo" />
        </Card>
      </aside>
      </div>
    </div>
  );
}
