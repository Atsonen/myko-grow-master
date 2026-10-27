// Lannoiteannostelu – ohjauspaneeli, EC-raja (±SP) -dialogi ja hälytys-/varoituslista (Plants > Dashboard).
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getFertDose, postFertDose, putFertDoseSettings, type FertDoseStatus } from "@/lib/apiClient";

export function useFertDose() {
  const [d, setD] = useState<FertDoseStatus | null>(null);
  const load = () => getFertDose().then(setD).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, []);
  return { d, load };
}
const hm = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("fi-FI", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const yn = (b?: boolean) => (b == null ? "—" : b ? "ON" : "OFF");

function Toggle({ on, label, onClick, disabled, title }: { on: boolean; label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return <button disabled={disabled} title={title} onClick={onClick} className={`rounded border px-2 py-0.5 ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"} disabled:opacity-50`}>{label}: {on ? "ON" : "OFF"}</button>;
}

export function FertEcDialog({ open, d, onClose, onSaved }: { open: boolean; d: FertDoseStatus | null; onClose: () => void; onSaved: () => void }) {
  const A = d?.config.ec_alarm;
  const [f, setF] = useState({ enabled: true, lo_off: "", hi_off: "", warn_lo_off: "", warn_hi_off: "", hyst: "", delay_min: "" });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && A) setF({ enabled: A.enabled, lo_off: String(A.lo_off), hi_off: String(A.hi_off), warn_lo_off: String(A.warn_lo_off), warn_hi_off: String(A.warn_hi_off), hyst: String(A.hyst), delay_min: String(A.delay_min) }); setErr(null); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (v: string) => Number(v.replace(",", "."));
  const save = async () => {
    setBusy(true); setErr(null);
    try { await putFertDoseSettings({ ec_alarm: { enabled: f.enabled, lo_off: n(f.lo_off), hi_off: n(f.hi_off), warn_lo_off: n(f.warn_lo_off), warn_hi_off: n(f.warn_hi_off), hyst: n(f.hyst), delay_min: n(f.delay_min) } }); onSaved(); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const sp = d?.sp; const abs = (o: string) => (sp != null && o.trim() !== "" ? ` = ${sp + n(o)}` : "");
  const inp = "w-full rounded border border-border bg-background px-2 py-1 font-mono text-sm";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md font-mono">
        <DialogHeader><DialogTitle className="text-base">EC-rajat suhteessa TDS_SP:hen (SP {sp ?? "—"} ppm)</DialogTitle></DialogHeader>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> EC-hälytykset ja -varoitukset käytössä</label>
          <div className="grid grid-cols-2 gap-2">
            <label>Hälytys ala (−){abs(f.lo_off)}<input className={inp} value={f.lo_off} onChange={(e) => setF({ ...f, lo_off: e.target.value })} /></label>
            <label>Hälytys ylä (+){abs(f.hi_off)}<input className={inp} value={f.hi_off} onChange={(e) => setF({ ...f, hi_off: e.target.value })} /></label>
            <label>Varoitus ala (−){abs(f.warn_lo_off)}<input className={inp} value={f.warn_lo_off} onChange={(e) => setF({ ...f, warn_lo_off: e.target.value })} /></label>
            <label>Varoitus ylä (+){abs(f.warn_hi_off)}<input className={inp} value={f.warn_hi_off} onChange={(e) => setF({ ...f, warn_hi_off: e.target.value })} /></label>
            <label>Hystereesi ppm<input className={inp} value={f.hyst} onChange={(e) => setF({ ...f, hyst: e.target.value })} /></label>
            <label>Hälytysviive min<input className={inp} value={f.delay_min} onChange={(e) => setF({ ...f, delay_min: e.target.value })} /></label>
          </div>
          <div className="text-xs text-muted-foreground">Poikkeamat ppm TDS_SP:stä (ala negatiivinen). HÄLYTYS: Telegram (Valvomo) alkaessa + palautuessa ja annostelun lukitus (Enable = FALSE). VAROITUS: vain listalla.</div>
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

export function FertDosePanel({ d, reload, onEcLimits }: { d: FertDoseStatus | null; reload: () => void; onEcLimits: () => void }) {
  const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  if (!d) return <div className="mt-2 font-mono text-xs text-muted-foreground">Lannoiteannostelu: ei dataa</div>;
  const set = async (b: Record<string, unknown>) => { setBusy(true); try { await putFertDoseSettings(b); await reload(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const doseNow = async () => { setBusy(true); setMsg(null); try { const r = await postFertDose(); setMsg(r.ok ? `Annospyyntö lähetetty (${r.mode})` : r.error ?? "virhe"); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); setConfirm(false); reload(); } };
  const c = d.config; const p = d.plc; const A = c.ec_alarm;
  const cum = (f: string) => d.cumulative.filter((x) => x.fert === f && x.mode === "live").reduce((a, x) => a + (x.act_ms || 0), 0) / 1000;
  const cumReq = (f: string) => d.cumulative.filter((x) => x.fert === f && x.mode === "live").reduce((a, x) => a + x.req_ms, 0) / 1000;
  const last = d.recent.find((r) => r.requested_ms > 0);
  return (
    <div className="mt-2 space-y-2 rounded border border-border px-3 py-2 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <b>Lannoiteannostelu</b>
        <span className={c.live ? "text-emerald-400" : "text-amber-400"}>{c.live ? "LIVE" : "EHDOTUS (dry-run)"}</span>
        {d.interlock && <span className="rounded bg-red-600 px-1.5 text-white">LUKITTU: EC-hälytys</span>}
        <Toggle on={c.live} label="Live" disabled={busy} onClick={() => set({ live: !c.live })} title="Live = kirjoitukset PLC:lle (FertDose_DB) bridgen kautta" />
        <Toggle on={c.hb_enabled} label="Heartbeat" disabled={busy} onClick={() => set({ hb_enabled: !c.hb_enabled })} />
        <Toggle on={c.plc_enable} label="Enable" disabled={busy} onClick={() => set({ plc_enable: !c.plc_enable })} title="FertDose_DB.Enable (EC-hälytys pakottaa OFF)" />
        <Toggle on={c.auto} label="Automaatti" disabled={busy} onClick={() => set({ auto: !c.auto })} />
        <span>letku säiliössä</span>
        {(["A", "B"] as const).map((f) => (
          <button key={f} disabled={busy} title="Sama pumppu – letku siirretään käsin. Valinta vain kirjanpitoa varten (Myko)." onClick={() => set({ fert: f })}
            className={`rounded border px-1.5 ${c.fert === f ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>{f}</button>
        ))}
        <span>annos {c.dose_s} s ≈ {c.dose_s} ml</span>
        <button disabled={busy || d.interlock} onClick={() => setConfirm(true)} className="rounded bg-amber-600 px-2 py-0.5 text-white disabled:opacity-50">Annostele nyt</button>
        <button onClick={onEcLimits} className="rounded border border-border px-2 py-0.5" title="Muokkaa EC-hälytys- ja varoitusrajoja (± SP)">EC-rajat: H {A.lo_off}/+{A.hi_off} · V {A.warn_lo_off}/+{A.warn_hi_off}{A.enabled ? "" : " (pois)"}</button>
      </div>
      <div className="text-muted-foreground">
        PLC: {p.present ? (p.fresh ? "" : "(vanha) ") : "FertDose_DB puuttuu (ei ladattu) · "}
        {p.present && <>Status {p.Status ?? "—"} {p.statusText ? `(${p.statusText})` : ""} · HB_OK {yn(p.HB_OK)} · Enable {yn(p.Enable)} · DoseActive {yn(p.DoseActive)} · DoseCount {p.DoseCount ?? "—"} · LastDose {p.LastDose_ms ?? "—"} ms · RunTime {p.RunTime_ms != null ? (p.RunTime_ms / 1000).toFixed(1) : "—"} s · </>}
        heartbeat {d.heartbeat} (#{d.hbValue})
      </div>
      <div className="text-muted-foreground">
        Tila: {d.reason} · EC {d.ec?.value ?? "—"} / SP {d.sp ?? "—"} · viimeisin {last ? `${hm(last.ts)} ${last.fert} ${last.requested_ms / 1000} s${last.actual_ms != null ? ` (tot. ${last.actual_ms / 1000} s)` : ""} [${last.mode}]` : "—"} · seuraava aikaisintaan {hm(d.nextAllowedAt)} · kumul. live A {cum("A")} s (pyydetty {cumReq("A")}) / B {cum("B")} s (pyydetty {cumReq("B")})
      </div>
      {msg && <div className="text-amber-400">{msg}</div>}
      <div>
        <b>Hälytykset ja varoitukset</b>
        <table className="mt-1 w-full">
          <tbody>
            {d.events.length === 0 && <tr><td className="text-muted-foreground">ei tapahtumia</td></tr>}
            {d.events.slice(0, 12).map((e) => (
              <tr key={e.id} className={!e.cleared_ts ? (e.level === "alarm" ? "text-red-400" : "text-amber-300") : "text-muted-foreground"}>
                <td className="pr-2">{e.level === "alarm" ? "HÄLYTYS" : "varoitus"}</td>
                <td className="pr-2">{!e.cleared_ts ? "AKTIIVINEN" : "poistunut"}</td>
                <td className="pr-2 whitespace-nowrap">{hm(e.ts)}{e.cleared_ts ? ` → ${hm(e.cleared_ts)}` : ""}</td>
                <td>{e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
        <DialogContent className="max-w-sm font-mono">
          <DialogHeader><DialogTitle className="text-base">Vahvista käsiannos</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <div>Lannoite <b>{c.fert}</b> (letku oikeassa säiliössä?), {c.dose_s} s ≈ {c.dose_s} ml. Tauko {c.pause_min} min ja EC-lukitus tarkistetaan. {c.live ? "Lähetetään PLC:lle." : "Dry-run: vain lokiin."}</div>
            <div className="flex justify-end gap-2">
              <button className="rounded border border-border px-3 py-1" onClick={() => setConfirm(false)}>Peruuta</button>
              <button className="rounded bg-amber-600 px-3 py-1 text-white disabled:opacity-50" disabled={busy} onClick={doseNow}>{busy ? "Lähetetään…" : "Annostele"}</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
