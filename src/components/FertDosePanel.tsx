// Lannoiteannostelu: kompakti tilarivi + iso EC-paneeli (EC vs SP, ±SP-rajat, ohjaus, PLC, luotettavuus, trendi, tapahtumaloki).
import { DisableDuration, untilLabel, useNow, reEnableAlarm } from "@/lib/alarmDisable";
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ackAlarms, getFertDose, postFertDose, putFertDoseSettings, type FertDoseStatus } from "@/lib/apiClient";

const FERT_ID = (id: number) => -(2_000_000_000 + id);
export async function ackFert(ids: number[]) { return ackAlarms(ids.map(FERT_ID)); }

export function useFertDose() {
  const [d, setD] = useState<FertDoseStatus | null>(null);
  const load = () => getFertDose().then(setD).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, []);
  return { d, load };
}
const hm = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("fi-FI", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const yn = (b?: boolean) => (b == null ? "—" : b ? "ON" : "OFF");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Switch({ on, label, onClick, disabled, title, testid }: { on: boolean; label: string; onClick: () => void; disabled?: boolean; title?: string; testid?: string }) {
  return (
    <button type="button" data-testid={testid} disabled={disabled} title={title} onClick={onClick}
      className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm transition-colors disabled:opacity-50 ${on ? "border-emerald-500/60 bg-emerald-500/10" : "border-border bg-muted/20 hover:bg-muted/40"}`}>
      <span>{label}</span>
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-emerald-500" : "bg-zinc-600"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}
function Badge({ kind, children }: { kind: "alarm" | "warning" | "ok" | "info" | "muted" | "live"; children: React.ReactNode }) {
  const c = { alarm: "bg-red-600 text-white", warning: "bg-amber-400 text-zinc-900", ok: "bg-emerald-600 text-white", info: "bg-sky-700 text-white", muted: "bg-zinc-700 text-zinc-200", live: "bg-violet-600 text-white" }[kind];
  return <span className={`inline-block rounded px-1.5 py-px text-[11px] font-bold uppercase tracking-wide ${c}`}>{children}</span>;
}
function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>{right}</div>
      {children}
    </section>
  );
}
function KV({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return <div className="flex justify-between gap-2 border-b border-border/40 py-0.5 last:border-0"><span className="text-muted-foreground">{k}</span><span className={`tabular-nums ${cls ?? ""}`}>{v}</span></div>;
}

function Trend({ d }: { d: FertDoseStatus }) {
  const pts = d.trend ?? []; const sp = d.sp; const A = d.config.ec_alarm;
  if (pts.length < 2) return <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">Trendi kertyy (1 min näytteet, max 6 h)…</div>;
  const W = 600, H = 150, P = 4;
  const vals = pts.map((p) => p[1]); const bands = sp != null ? [sp + A.lo_off, sp + A.hi_off] : [];
  let lo = Math.min(...vals, ...(sp != null ? [sp + A.warn_lo_off] : [])), hi = Math.max(...vals, ...(sp != null ? [sp + A.warn_hi_off] : []));
  const pad = Math.max(50, (hi - lo) * 0.1); lo -= pad; hi += pad;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const band = (a: number, b: number, fill: string) => { const ya = y(Math.min(hi, Math.max(lo, b))), yb = y(Math.min(hi, Math.max(lo, a))); return <rect x={0} y={ya} width={W} height={Math.max(0, yb - ya)} fill={fill} />; };
  // Live-annokset trendivälillä: merkki + tooltip (aika, A/B, ml). 1 s ≈ 1 ml.
  const doses = (d.recent ?? []).filter((r) => r.mode === "live" && (r.requested_ms ?? 0) > 0).map((r) => {
    const ts = Date.parse(r.ts); const ml = (r.actual_ms ?? r.requested_ms) / 1000;
    const nearest = pts.reduce((best, p) => Math.abs(p[0] - ts) < Math.abs(best[0] - ts) ? p : best, pts[0]);
    return { ts, fert: r.fert, ml, ec: nearest[1], inRange: ts >= t0 - 60_000 && ts <= t1 + 60_000 };
  }).filter((r) => r.inRange);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" preserveAspectRatio="none" data-testid="fd-trend">
        {sp != null && band(sp + A.warn_lo_off, sp + A.warn_hi_off, "rgba(16,185,129,0.10)")}
        {sp != null && <line x1={0} x2={W} y1={y(sp)} y2={y(sp)} stroke="#a1a1aa" strokeDasharray="4 4" strokeWidth={1} />}
        {bands.map((b, i) => b > lo && b < hi && <line key={i} x1={0} x2={W} y1={y(b)} y2={y(b)} stroke="#ef4444" strokeDasharray="2 3" strokeWidth={1} />)}
        <path d={line} fill="none" stroke="#38bdf8" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {doses.map((r) => (
          <g key={r.ts} data-testid="fd-trend-dose">
            <title>{`${new Date(r.ts).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${r.fert} · ${r.ml.toFixed(1)} ml`}</title>
            <line x1={x(r.ts)} x2={x(r.ts)} y1={y(r.ec) - 10} y2={H - P} stroke="#f59e0b" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            <circle cx={x(r.ts)} cy={y(r.ec)} r={4} fill="#f59e0b" stroke="#18181b" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={x(r.ts) + 5} y={Math.max(10, y(r.ec) - 8)} fill="#fbbf24" fontSize="9" style={{ fontFamily: "ui-monospace, monospace" }}>{`${r.fert} ${r.ml.toFixed(0)}ml`}</text>
          </g>
        ))}
      </svg>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{new Date(t0).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" })}</span>
        <span><span className="text-sky-400">━</span> EC · <span>┅</span> SP · <span className="text-amber-400">●</span> annos · <span className="text-emerald-400">▮</span> varoitusalue · <span className="text-red-400">┅</span> hälytysraja</span>
        <span>{new Date(t1).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}


function DoseEditor({ d, reload }: { d: FertDoseStatus; reload: () => void }) {
  const cur = Number(d.config.dose_s) || 1;
  const [v, setV] = useState(String(cur)); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const n = Number(String(v).replace(",", "."));
  const steps = Math.round(n * 2); const ok = Number.isFinite(n) && steps >= 1 && steps <= 10 && Math.abs(n - steps / 2) < 1e-9; /* max 5.0 s */
  const save = async () => {
    setBusy(true); setMsg(null);
    try { await putFertDoseSettings({ dose_s: steps / 2 }); setMsg("Tallennettu"); reload(); }
    catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 rounded-md border border-border/70 bg-black/20 p-2">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Annoskoko (pumpun ajoaika)</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input data-testid="fd-dose-s" inputMode="decimal" step={0.5} min={0.5} max={5} value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ok && steps / 2 !== cur && save()}
          className={`w-20 rounded-md border bg-background px-2 py-1 font-mono text-sm tabular-nums focus:outline-none ${ok ? "border-border focus:border-sky-500" : "border-red-500"}`} />
        <span className="text-xs text-muted-foreground">s ≈ {ok ? n : "—"} ml</span>
        <button type="button" data-testid="fd-dose-s-save" disabled={!ok || busy || (ok && steps / 2 === cur)} onClick={save}
          className="rounded-md bg-sky-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">Tallenna</button>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {!ok ? <span className="text-red-400">0.5–5 s, askel 0.5 (DoseReq 500–5000 ms)</span>
          : msg ? <span className={msg === "Tallennettu" ? "text-emerald-400" : "text-red-400"}>{msg}</span>
          : <>Myko lähettää DoseReq_ms (500–5000) → Pumput.FertDose.</>}
      </div>
    </div>
  );
}

function SpEditor({ d, reload }: { d: FertDoseStatus; reload: () => void }) {
  const cur = d.config.ec_sp ?? d.sp ?? 0;
  const [v, setV] = useState(String(cur)); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const n = Number(v.replace(",", ".")); const ok = Number.isFinite(n) && n >= 100 && n <= 9000;
  const save = async () => { setBusy(true); setMsg(null); try { await putFertDoseSettings({ ec_sp: Math.round(n) }); setMsg("Tallennettu"); reload(); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); } };
  return (
    <div className="mt-3 rounded-md border border-border/70 bg-black/20 p-2">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">EC-asetusarvo (Myko)</div>
      <div className="mt-1 flex items-center gap-2">
        <input data-testid="fd-sp" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok && n !== cur && save()}
          className={`w-24 rounded-md border bg-background px-2 py-1 font-mono text-sm tabular-nums focus:outline-none ${ok ? "border-border focus:border-sky-500" : "border-red-500"}`} />
        <span className="text-xs text-muted-foreground">ppm</span>
        <button type="button" data-testid="fd-sp-save" disabled={!ok || busy || n === cur} onClick={save} className="rounded-md bg-sky-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">Tallenna</button>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{!ok ? <span className="text-red-400">100–9000 ppm</span> : msg ? <span className={msg === "Tallennettu" ? "text-emerald-400" : "text-red-400"}>{msg}</span> : "Ohjaa annostelua ja ±SP-rajoja."} PLC TDS_SP (vain vertailu): <b>{d.spPlc ?? "—"}</b></div>
    </div>
  );
}

function LimitsEditor({ d, reload }: { d: FertDoseStatus; reload: () => void }) {
  const A = d.config.ec_alarm;
  const init = () => ({ enabled: A.enabled, lo_off: String(A.lo_off), hi_off: String(A.hi_off), warn_lo_off: String(A.warn_lo_off), warn_hi_off: String(A.warn_hi_off), hyst: String(A.hyst), delay_min: String(A.delay_min) });
  const [f, setF] = useState(init); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [disMin, setDisMin] = useState(60); const now = useNow(15_000);
  const n = (v: string) => Number(v.replace(",", "."));
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const save = async () => {
    setBusy(true); setMsg(null);
    try { await putFertDoseSettings({ ec_alarm: { enabled: f.enabled, ...(!f.enabled && A.enabled ? { disable_min: disMin } : {}), lo_off: n(f.lo_off), hi_off: n(f.hi_off), warn_lo_off: n(f.warn_lo_off), warn_hi_off: n(f.warn_hi_off), hyst: n(f.hyst), delay_min: n(f.delay_min) } }); setMsg("Tallennettu"); reload(); }
    catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  const sp = d.sp; const abs = (o: string) => (sp != null && o.trim() !== "" && Number.isFinite(n(o)) ? `= ${sp + n(o)} ppm` : "");
  const inp = "w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm tabular-nums focus:border-sky-500 focus:outline-none";
  const F = (k: keyof typeof f, label: string, hint?: string) => (
    <label className="text-xs"><span className="text-muted-foreground">{label}</span>
      <input data-testid={`fd-lim-${k}`} className={inp} value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      <span className="text-[11px] text-muted-foreground">{hint ?? abs(String(f[k]))}</span></label>
  );
  return (
    <Section title="EC-rajat suhteessa SP:hen" right={<Switch on={f.enabled} label="Käytössä" onClick={() => setF({ ...f, enabled: !f.enabled })} />}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {F("lo_off", "Hälytys ala (SP −)")}{F("hi_off", "Hälytys ylä (SP +)")}
        {F("warn_lo_off", "Varoitus ala (SP −)")}{F("warn_hi_off", "Varoitus ylä (SP +)")}
        {F("hyst", "Hystereesi (ppm)", " ")}{F("delay_min", "Viive (min)", " ")}
      </div>
      {!A.enabled && A.disabled_until && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300" data-testid="fd-dis-until">
          <span>🔕 EC-hälytys {untilLabel(A.disabled_until, now)} · EC epäluotettava/vanha estää silti annostelun</span>
          <button type="button" disabled={busy} className="rounded border border-amber-400 px-2 py-0.5" onClick={async () => { setBusy(true); try { await reEnableAlarm("fert", "ec"); setMsg("Tallennettu"); reload(); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); } }}>Päälle nyt</button>
        </div>)}
      {!f.enabled && A.enabled && <div className="mb-2"><DisableDuration value={disMin} onChange={setDisMin} /></div>}
      <div className="mt-2 text-[11px] text-muted-foreground">Hälytys → Telegram (Valvomo) + lukitus (Enable OFF). Varoitus → vain listaan.</div>
      <div className="mt-2 flex items-center justify-end gap-2">
        {msg && <span className={`text-xs ${msg === "Tallennettu" ? "text-emerald-400" : "text-red-400"}`}>{msg}</span>}
        <button type="button" disabled={!dirty || busy} onClick={() => setF(init())} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40">Palauta</button>
        <button type="button" data-testid="fd-lim-save" disabled={!dirty || busy} onClick={save} className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Tallennetaan…" : "Tallenna"}</button>
      </div>
    </Section>
  );
}

type LogRow = { key: string; id?: number; ts: string; end?: string | null; kind: "alarm" | "warning" | "dose"; active: boolean; text: string; mode?: string; acked?: string | null; ackedBy?: string | null };
function EventLog({ d, reload }: { d: FertDoseStatus; reload: () => void }) {
  const [flt, setFlt] = useState<"all" | "alarm" | "warning" | "dose">(() => { try { return (localStorage.getItem("myko.fertLog.kind") as never) || "all"; } catch { return "all"; } });
  const [activeOnly, setActiveOnly] = useState(() => { try { return localStorage.getItem("myko.fertLog.active") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("myko.fertLog.kind", flt); localStorage.setItem("myko.fertLog.active", activeOnly ? "1" : "0"); } catch { /* */ } }, [flt, activeOnly]);
  const rows = useMemo<LogRow[]>(() => {
    const ev: LogRow[] = d.events.map((e) => ({ key: `e${e.id}`, id: e.id, ts: e.ts ?? "", end: e.cleared_ts, kind: e.level, active: !e.cleared_ts, text: e.text, acked: e.acked_ts, ackedBy: e.acked_by }));
    const dz: LogRow[] = d.recent.map((r, i) => ({ key: `d${i}${r.ts}`, ts: r.ts, kind: "dose", active: false, mode: r.mode,
      text: `${r.fert} ${(r.requested_ms / 1000).toFixed(1)} s${r.actual_ms != null ? ` (tot. ${(r.actual_ms / 1000).toFixed(1)} s)` : ""}${r.ec_before != null ? ` · EC ${r.ec_before}/${r.ec_sp ?? "—"}` : ""} · ${r.reason}` }));
    return [...ev, ...dz].filter((r) => (flt === "all" || r.kind === flt) && (!activeOnly || r.active)).sort((a, b) => b.ts.localeCompare(a.ts));
  }, [d.events, d.recent, flt, activeOnly]);
  const modeKind = (m?: string) => (m === "live" ? "live" : m === "dry-run" ? "muted" : m === "blocked" || m === "live-fail" ? "alarm" : "info") as "live";
  const chip = (k: typeof flt, l: string) => <button type="button" onClick={() => setFlt(k)} className={`rounded-full border px-2.5 py-0.5 text-xs ${flt === k ? "border-sky-500 bg-sky-500/20 text-sky-200" : "border-border text-muted-foreground"}`}>{l}</button>;
  return (
    <Section title={`Tapahtumaloki (${rows.length})`} right={<div className="flex flex-wrap items-center gap-1.5" data-testid="fd-log-filters">
      {chip("all", "Kaikki")}{chip("alarm", "Hälytykset")}{chip("warning", "Varoitukset")}{chip("dose", "Annokset")}
      <label className="ml-1 flex items-center gap-1 text-xs"><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> vain aktiiviset</label></div>}>
      <div className="max-h-72 overflow-auto rounded border border-border/60">
        <table className="w-full text-xs" data-testid="fd-log">
          <thead className="sticky top-0 bg-zinc-900 text-left text-[11px] uppercase text-muted-foreground"><tr><th className="px-2 py-1">Aika</th><th className="px-2 py-1">Tyyppi</th><th className="px-2 py-1">Tila</th><th className="px-2 py-1">Kuvaus</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4} className="px-2 py-3 text-center text-muted-foreground">ei tapahtumia</td></tr>}
            {rows.map((r) => (
              <tr key={r.key} className={`border-t border-border/40 ${r.active ? (r.kind === "alarm" ? "bg-red-950/40" : "bg-amber-950/30") : ""}`}>
                <td className="whitespace-nowrap px-2 py-1 tabular-nums">{hm(r.ts)}{r.end ? <div className="text-[11px] text-muted-foreground">→ {hm(r.end)}</div> : null}</td>
                <td className="px-2 py-1">{r.kind === "alarm" ? <Badge kind="alarm">Hälytys</Badge> : r.kind === "warning" ? <Badge kind="warning">Varoitus</Badge> : <Badge kind={modeKind(r.mode)}>Annos · {r.mode}</Badge>}</td>
                <td className="px-2 py-1">{r.kind === "dose" ? "—" : r.active ? <Badge kind={r.kind === "alarm" ? "alarm" : "warning"}>Aktiivinen</Badge> : <Badge kind="muted">Poistunut</Badge>}</td>
                <td className="px-2 py-1">{r.text}{r.kind === "alarm" && (r.acked ? <div className="text-[11px] text-muted-foreground">kuitattu {hm(r.acked)}{r.ackedBy ? ` · ${r.ackedBy}` : ""}</div>
                  : <button type="button" data-testid="fd-ack-row" onClick={async () => { if (r.id) { await ackFert([r.id]); reload(); } }} className="ml-2 rounded border border-red-500/70 px-2 py-px text-[11px] font-semibold text-red-200 hover:bg-red-500/20">Kuittaa</button>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export function FertEcModal({ open, d, reload, onClose }: { open: boolean; d: FertDoseStatus | null; reload: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  if (!d) return null;
  const set = async (b: Record<string, unknown>) => { setBusy(true); setMsg(null); try { await putFertDoseSettings(b); await reload(); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); } };
  const doseNow = async () => { setBusy(true); setMsg(null); try { const r = await postFertDose(); setMsg(r.ok ? `Annospyyntö lähetetty (${r.mode})` : r.error ?? "virhe"); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); setConfirm(false); reload(); } };
  const c = d.config; const p = d.plc; const A = c.ec_alarm; const ec = d.ec?.value ?? null; const sp = d.sp;
  const dev = ec != null && sp != null ? ec - sp : null;
  const sev = dev == null ? "muted" : dev <= A.lo_off || dev >= A.hi_off ? "alarm" : dev <= A.warn_lo_off || dev >= A.warn_hi_off ? "warning" : "ok";
  const sevCls = { alarm: "text-red-400", warning: "text-amber-300", ok: "text-emerald-400", muted: "text-muted-foreground" }[sev];
  const tot = (f: string, k: "act_ms" | "req_ms", mode = "live") => d.cumulative.filter((x) => x.fert === f && x.mode === mode).reduce((a, x) => a + (x[k] || 0), 0) / 1000;
  const cnt = (f: string, mode = "live") => d.cumulative.filter((x) => x.fert === f && x.mode === mode).reduce((a, x) => a + x.n, 0);
  const rel = d.reliable;
  const unacked = d.events.filter((e) => e.level === "alarm" && !e.acked_ts && e.id).map((e) => e.id as number);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,1100px)] max-w-none overflow-y-auto border-zinc-700 bg-zinc-950 p-0 font-mono" data-testid="fd-modal">
        <DialogHeader className="sticky top-0 z-10 border-b border-border bg-zinc-950/95 px-5 py-3 backdrop-blur">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            EC & lannoiteannostelu
            <Badge kind={c.live ? "live" : "muted"}>{c.live ? "Live" : "Dry-run"}</Badge>
            {d.interlock && <Badge kind="alarm">Lukittu: EC-hälytys</Badge>}
            {d.active.map((a) => <Badge key={a.code} kind={a.level === "alarm" ? "alarm" : "warning"}>{a.code}</Badge>)}
            {unacked.length > 0 && <button type="button" data-testid="fd-ack" onClick={async () => { await ackFert(unacked); reload(); }} className="ml-auto mr-8 rounded-md border border-red-500 bg-red-600/20 px-3 py-1 text-xs font-bold text-red-100 hover:bg-red-600/40">Kuittaa ({unacked.length})</button>}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 p-4 lg:grid-cols-3">
          <section className="rounded-lg border border-border bg-gradient-to-br from-zinc-900 to-zinc-950 p-4 lg:col-span-1">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">EC nyt</div>
            <div className={`text-5xl font-bold tabular-nums ${sevCls}`} data-testid="fd-ec">{ec ?? "—"}<span className="ml-1 text-lg text-muted-foreground">ppm</span></div>
            <div className="mt-1 text-sm">SP <b className="tabular-nums">{sp ?? "—"}</b> · poikkeama <b className={`tabular-nums ${sevCls}`}>{dev == null ? "—" : `${dev > 0 ? "+" : ""}${dev}`}</b></div>
            <div className="mt-1 text-[11px] text-muted-foreground">mitattu {hm(d.ec?.at)}</div>
            <SpEditor key={String(c.ec_sp ?? sp)} d={d} reload={reload} />
            {sp != null && <div className="mt-3 space-y-0.5 text-xs">
              <KV k="Hälytys" v={`${sp + A.lo_off} … ${sp + A.hi_off}`} cls="text-red-300" />
              <KV k="Varoitus" v={`${sp + A.warn_lo_off} … ${sp + A.warn_hi_off}`} cls="text-amber-200" />
            </div>}
            <div className="mt-3 flex items-center gap-2 text-xs">{rel?.ok ? <Badge kind="ok">Mittaus luotettava</Badge> : <Badge kind="warning">Epäluotettava</Badge>}<span className="text-muted-foreground">{rel?.ok ? (d.validSince ? `${hm(d.validSince)} alkaen` : "") : rel?.why ?? "—"}</span></div>
          </section>
          <section className="rounded-lg border border-border bg-card/60 p-3 lg:col-span-2"><div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">EC-trendi</div><Trend d={d} /></section>

          <Section title="Annostelun ohjaus">
            <div className="grid grid-cols-2 gap-2">
              {/* Live + Automaatti toggles removed from UI (1.11.2026): Live=true → real PLC writes; Automaatti=auto dosing. Keep state; badge still shows Live/Dry-run. */}
              <Switch on={c.hb_enabled} label="Heartbeat" disabled={busy} onClick={() => set({ hb_enabled: !c.hb_enabled })} />
              <Switch on={c.plc_enable} label="Enable" disabled={busy} onClick={() => set({ plc_enable: !c.plc_enable })} title="Pumput.FertDose.Enable (EC-hälytys pakottaa OFF)" />
            </div>
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Letku säiliössä</span>
              <div className="inline-flex overflow-hidden rounded-md border border-border">{(["A", "B"] as const).map((f) => (
                <button key={f} type="button" disabled={busy} onClick={() => set({ fert: f })} title="Sama pumppu – letku siirretään käsin (vain kirjanpito)"
                  className={`px-4 py-1 font-bold ${c.fert === f ? "bg-sky-600 text-white" : "text-muted-foreground hover:bg-muted/40"}`}>{f}</button>))}</div>
            </div>
            <DoseEditor key={`dose-${c.dose_s}`} d={d} reload={reload} />
            <button type="button" data-testid="fd-dose" disabled={busy || d.interlock} onClick={() => setConfirm(true)}
              className="mt-3 w-full rounded-md bg-amber-500 py-2 text-sm font-bold text-zinc-900 hover:bg-amber-400 disabled:opacity-40">Annostele nyt…</button>
            <div className="mt-2 space-y-0.5 text-xs">
              <KV k="Tila" v={d.reason} />
              <KV k="Alle SP alkaen" v={hm(d.belowSince)} />
              <KV k="Viimeisin annos" v={hm(d.lastDoseAt)} />
              <KV k="Seuraava auto aikaisintaan" v={hm(d.nextAllowedAt)} />
              <KV k="Ehdot (auto)" v={`alle SP ${c.below_min} min · tauko ${c.pause_min} min`} />
              <KV k="Käsiannos" v="ohittaa tauon · käynnistää tauon alusta" />
            </div>
            {msg && <div className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">{msg}</div>}
          </Section>

          <Section title="PLC Pumput.FertDose" right={!p.present ? <Badge kind="alarm">DB puuttuu</Badge> : p.fresh ? <Badge kind="ok">Yhteys</Badge> : <Badge kind="warning">Vanha data</Badge>}>
            <div className="space-y-0.5 text-xs">
              <KV k="Status" v={`${p.Status ?? "—"}${p.statusText ? ` · ${p.statusText}` : ""}`} />
              <KV k="Interlock" v={yn((p as { Interlock?: boolean }).Interlock)} cls={(p as { Interlock?: boolean }).Interlock ? "text-emerald-400" : "text-amber-300"} />
              <KV k="HB_OK" v={yn(p.HB_OK)} cls={p.HB_OK ? "text-emerald-400" : ""} />
              <KV k="Enable" v={yn(p.Enable)} />
              <KV k="DoseActive" v={yn(p.DoseActive)} cls={p.DoseActive ? "text-amber-300" : ""} />
              <KV k="DoseCount" v={p.DoseCount ?? "—"} />
              <KV k="LastDose" v={p.LastDose_ms != null ? `${p.LastDose_ms} ms` : "—"} />
              <KV k="RunTime" v={p.RunTime_ms != null ? `${(p.RunTime_ms / 1000).toFixed(1)} s` : "—"} />
              <KV k="Heartbeat" v={`${d.heartbeat} (#${d.hbValue})`} cls={d.heartbeat === "ok" ? "text-emerald-400" : "text-amber-300"} />
              {d.plc_write_allowed === false && <div className="pt-1 text-[11px] text-amber-400">Kirjoitus PLC:hen pois</div>}
            </div>
          </Section>

          <Section title="Kumulatiiviset annokset">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-[11px] uppercase text-muted-foreground"><tr><th className="text-left">Lannoite</th><th className="text-right">Live kpl</th><th className="text-right">Pyydetty</th><th className="text-right">Toteutunut</th><th className="text-right">Dry-run</th></tr></thead>
              <tbody>{(["A", "B"] as const).map((f) => (
                <tr key={f} className="border-t border-border/40"><td className="py-1 font-bold">{f}</td><td className="text-right">{cnt(f)}</td><td className="text-right">{tot(f, "req_ms").toFixed(1)} s</td><td className="text-right">{tot(f, "act_ms").toFixed(1)} s ≈ {tot(f, "act_ms").toFixed(0)} ml</td><td className="text-right text-muted-foreground">{cnt(f, "dry-run")}</td></tr>))}</tbody>
            </table>
          </Section>

          <div className="lg:col-span-1"><LimitsEditor key={JSON.stringify(A)} d={d} reload={reload} /></div>
          <div className="lg:col-span-2"><EventLog d={d} reload={reload} /></div>
        </div>
        <Dialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
          <DialogContent className="max-w-sm font-mono">
            <DialogHeader><DialogTitle className="text-base">Vahvista käsiannos</DialogTitle></DialogHeader>
            <div className="space-y-3 text-sm">
              <div>Lannoite <b>{c.fert}</b> (letku oikeassa säiliössä?), {c.dose_s} s ≈ {c.dose_s} ml. EC-lukitus ja PLC-turvaehdot tarkistetaan; auto-tauko ohitetaan (käsiannos käynnistää {c.pause_min} min tauon alusta). {c.live ? "Lähetetään PLC:lle." : "Dry-run: vain lokiin."}</div>
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-md border border-border px-3 py-1.5" onClick={() => setConfirm(false)}>Peruuta</button>
                <button type="button" data-testid="fd-dose-confirm" className="rounded-md bg-amber-500 px-4 py-1.5 font-semibold text-zinc-900 disabled:opacity-50" disabled={busy} onClick={doseNow}>{busy ? "Lähetetään…" : "Annostele"}</button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

/** Kompakti tilarivi prosessinäkymän alle; klikkaus avaa ison EC-paneelin. */
export function FertDosePanel({ d, onOpen }: { d: FertDoseStatus | null; onOpen: () => void }) {
  if (!d) return <div className="mt-2 font-mono text-xs text-muted-foreground">Lannoiteannostelu: ei dataa</div>;
  const c = d.config;
  return (
    <button type="button" onClick={onOpen} data-testid="fd-strip" className="mt-2 flex w-full flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-left font-mono text-xs hover:bg-muted/30">
      <b>Lannoiteannostelu</b>
      <Badge kind={c.live ? "live" : "muted"}>{c.live ? "Live" : "Dry-run"}</Badge>
      {d.interlock && <Badge kind="alarm">Lukittu</Badge>}
      {d.active.map((a) => <Badge key={a.code} kind={a.level === "alarm" ? "alarm" : "warning"}>{a.code}</Badge>)}
      <span className="text-muted-foreground">EC {d.ec?.value ?? "—"} / SP {d.sp ?? "—"} · {d.reason} · PLC {d.plc.present ? (d.plc.statusText ?? "—") : "DB puuttuu"}</span>
      <span className="ml-auto text-sky-400">Avaa EC-paneeli →</span>
    </button>
  );
}
