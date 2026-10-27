// Kiertovesisekvenssi FB_Sequence_DB – tila (vain luku, bridge-pollaus) + asetukset (vain myko_settings, ei PLC-kirjoitusta).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getSequence, putSequence, type SequenceResponse } from "@/lib/apiClient";

const STEPS: [number, string][] = [[0, "Seis"], [1, "Kierrätys"], [2, "Tasaantuminen"], [3, "Pinnan tallennus"], [4, "Täyttö"]];
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function useSequence() {
  const [d, setD] = useState<SequenceResponse | null>(null);
  const load = () => getSequence().then(setD).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, []);
  return { d, load };
}

export function SequencePanel() {
  const { d, load } = useSequence();
  const [f, setF] = useState<{ enable: boolean; t_circ_s: string; t_settle_s: string; t_fill_s: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (d && !f) setF({ enable: d.settings.enable, t_circ_s: String(d.settings.t_circ_s), t_settle_s: String(d.settings.t_settle_s), t_fill_s: String(d.settings.t_fill_s) }); }, [d, f]);
  const p = d?.plc ?? {};
  const live = !!d?.present;
  const step = live ? p.Step : undefined;
  const setMs = (s?: number) => s === 1 ? p.T_Circ : s === 2 ? p.T_Settle : s === 4 ? p.T_Fill : undefined;
  const rem = live && setMs(step) !== undefined && p.StepTime_ms !== undefined ? (setMs(step) as number) - p.StepTime_ms : undefined;
  const save = async () => {
    if (!f) return; setSaving(true);
    try { await putSequence({ enable: f.enable, t_circ_s: Number(f.t_circ_s), t_settle_s: Number(f.t_settle_s), t_fill_s: Number(f.t_fill_s) }); toast.success("Tallennettu Mykoon (ei PLC:hen)"); load(); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };
  const b = (v: boolean | undefined, on: string, off: string, bad = false) => (
    <span className={`rounded px-1.5 py-0.5 ${v === undefined ? "bg-muted text-muted-foreground" : v !== bad ? "bg-emerald-600/20 text-emerald-400" : "bg-red-600/20 text-red-400"}`}>{v === undefined ? "–" : v ? on : off}</span>);
  return (
    <div className="flex h-full flex-col gap-2 text-xs font-mono" data-testid="seq-panel">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Kiertovesisekvenssi · FB_Sequence_DB</h2>
        <span className="ml-auto text-[10px] text-muted-foreground">{d?.plc_at ? `PLC ${new Date(d.plc_at).toLocaleTimeString("fi-FI")}` : ""}</span>
      </div>
      {!live && <div className="rounded border border-amber-600/50 bg-amber-600/10 px-2 py-1 text-amber-400">
        {d && !d.stale ? "FB_Sequence_DB ei löydy OPC UA:sta" : "Ei dataa bridgeltä (Sensors/PLC_2/Sequence)"} – näytetään vain Myko-asetukset.</div>}
      <div className="flex flex-wrap gap-1">
        {STEPS.map(([n, t]) => (
          <div key={n} className={`flex-1 min-w-[90px] rounded border px-2 py-1 ${step === n ? "border-sky-400 bg-sky-500/20 text-sky-200" : "border-border text-muted-foreground"}`}>
            <div className="text-[10px]">Askel {n}</div><div className="font-medium">{t}</div>
            {step === n && rem !== undefined && <div className="text-[11px]">jäljellä {mmss(rem)}</div>}
          </div>))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>HB {b(live ? p.HB_OK : undefined, "OK", "PUUTTUU", false)}</span>
        <span>Tila {b(live ? !p.Stopped : undefined, "käy", "PYSÄYTETTY")}</span>
        <span>Vuoto {b(live ? !p.LeakAlarm : undefined, "ei", "HÄLYTYS")}</span>
        <span>Syklit <b>{live ? p.CycleCount ?? "–" : "–"}</b></span>
        <span>Askelaika <b>{live && p.StepTime_ms !== undefined ? mmss(p.StepTime_ms) : "–"}</b></span>
      </div>
      {f && <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
        {([["t_circ_s", "T_Circ (kierrätys)", p.T_Circ], ["t_settle_s", "T_Settle (tasaantuminen)", p.T_Settle], ["t_fill_s", "T_Fill (täyttö)", p.T_Fill]] as const).map(([k, l, pv]) => (
          <div key={k} className="contents">
            <label htmlFor={`seq-${k}`}>{l}</label>
            <input id={`seq-${k}`} type="number" min={1} className="h-7 rounded border border-border bg-background px-2" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            <span className="text-muted-foreground">s · PLC {live && pv !== undefined ? `${Math.round(pv / 1000)} s` : "–"}</span>
          </div>))}
        <label htmlFor="seq-en">Enable</label>
        <input id="seq-en" type="checkbox" className="h-4 w-4 justify-self-start" checked={f.enable} onChange={(e) => setF({ ...f, enable: e.target.checked })} />
        <span className="text-muted-foreground">PLC {live ? (p.Enable ? "päällä" : "pois") : "–"}</span>
      </div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving || !f}>Tallenna asetukset</Button>
        <span className="text-[11px] text-amber-400">Kirjoitus PLC:hen ei käytössä – odottaa latausta/hyväksyntää</span>
      </div>
      <div className="text-[10px] text-muted-foreground">Asetukset tallentuvat vain Mykoon (myko_settings). Heartbeat pois käytöstä. Luku: bridge Read-pollaus 2 s.</div>
    </div>
  );
}
