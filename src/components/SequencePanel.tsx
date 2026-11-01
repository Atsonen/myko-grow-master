// Kiertovesisekvenssi Pumput_DB.Static.Sequence + CircPump_L/R – tila + CircPump Enable + Sequence Käynnistä/Pysäytä.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getSequence, putSequence, setCircPumpEnable, setSequenceEnable, type SequenceResponse } from "@/lib/apiClient";

const STEPS: [number, string][] = [[0, "Seis"], [1, "Kierrätys"], [2, "Tasaantuminen"], [3, "Pinnan tallennus"], [4, "Täyttö"]];
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const ERR = { 0: "ok", 1: "MaxRun ylitetty", 2: "käyntitieto puuttuu" } as Record<number, string>;

function pumpState(p: Record<string, unknown>, sd: "L" | "R"): { label: string; kind: "run" | "wait" | "err" | "off" | "idle" } {
  const err = p[`${sd}_Error`] === true;
  const run = p[`${sd}_Running`] === true || p[`${sd}_Pump`] === true;
  const wait = p[`${sd}_Waiting`] === true;
  const en = p[`${sd}_Enable`];
  if (err) return { label: "VIKA", kind: "err" };
  if (en === false) return { label: "pois käytöstä", kind: "off" };
  if (wait) return { label: "odottaa", kind: "wait" };
  if (run) return { label: "käy", kind: "run" };
  return { label: "seis", kind: "idle" };
}

export function useSequence() {
  const [d, setD] = useState<SequenceResponse | null>(null);
  const load = () => getSequence().then(setD).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, []);
  return { d, load };
}

export function SequencePanel() {
  const { d, load } = useSequence();
  const [f, setF] = useState<{ t_circ_s: string; t_settle_s: string; t_fill_s: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [seqBusy, setSeqBusy] = useState(false);
  useEffect(() => {
    if (d && !f) setF({ t_circ_s: String(d.settings.t_circ_s), t_settle_s: String(d.settings.t_settle_s), t_fill_s: String(d.settings.t_fill_s) });
  }, [d, f]);
  const p = (d?.plc ?? {}) as Record<string, unknown>;
  const live = !!d?.present;
  const step = live ? (p.Step as number | undefined) : undefined;
  const setMs = (s?: number) => s === 1 ? (p.T_Circ as number | undefined) : s === 2 ? (p.T_Settle as number | undefined) : s === 4 ? (p.T_Fill as number | undefined) : undefined;
  const rem = live && setMs(step) !== undefined && p.StepTime_ms !== undefined ? (setMs(step) as number) - (p.StepTime_ms as number) : undefined;
  const [pumpBusy, setPumpBusy] = useState<"L" | "R" | null>(null);
  const plcEnable = live ? (p.Enable as boolean | undefined) : undefined;
  const running = plcEnable === true && p.Stopped !== true;
  const tankFromTank = live && typeof p.TankLevel === "number" ? (p.TankLevel as number) : undefined;
  const snapLevel = live && typeof p.Level === "number" ? (p.Level as number) : undefined;

  const togglePump = async (sd: "L" | "R", en: boolean) => {
    const name = sd === "L" ? "vasen" : "oikea";
    if (!window.confirm(`Vahvista: kiertopumppu ${name} → ${en ? "KÄYTTÖÖN (Enable ON)" : "POIS KÄYTÖSTÄ (Enable OFF)"}?`)) return;
    setPumpBusy(sd);
    try { await setCircPumpEnable(sd, en); toast.success(`Kiertopumppu ${name}: ${en ? "käytössä" : "pois käytöstä"}`); load(); }
    catch (e) { toast.error((e as Error).message); } finally { setPumpBusy(null); }
  };
  const toggleSeq = async (en: boolean) => {
    const msg = en
      ? "Vahvista: Käynnistä kiertovesisekvenssi (Sequence.Enable → TRUE)?"
      : "Vahvista: Pysäytä kiertovesisekvenssi (Sequence.Enable → FALSE)?";
    if (!window.confirm(msg)) return;
    setSeqBusy(true);
    try {
      await setSequenceEnable(en);
      toast.success(en ? "Sekvenssi käynnistetty" : "Sekvenssi pysäytetty");
      load();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSeqBusy(false); }
  };
  const save = async () => {
    if (!f) return; setSaving(true);
    try {
      await putSequence({ t_circ_s: Number(f.t_circ_s), t_settle_s: Number(f.t_settle_s), t_fill_s: Number(f.t_fill_s) });
      toast.success("Ajat tallennettu Mykoon (ei PLC:hen)"); load();
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };
  const b = (v: boolean | undefined, on: string, off: string, bad = false) => (
    <span className={`rounded px-1.5 py-0.5 ${v === undefined ? "bg-muted text-muted-foreground" : v !== bad ? "bg-emerald-600/20 text-emerald-400" : "bg-red-600/20 text-red-400"}`}>{v === undefined ? "–" : v ? on : off}</span>);
  const stCls = { run: "bg-emerald-600/20 text-emerald-300", wait: "bg-amber-500/20 text-amber-300", err: "bg-red-600/20 text-red-300", off: "bg-zinc-600/40 text-zinc-300", idle: "bg-muted text-muted-foreground" } as const;
  return (
    <div className="flex h-full flex-col gap-2 text-xs font-mono" data-testid="seq-panel">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Kiertovesisekvenssi · Pumput.Sequence</h2>
        <span className="ml-auto text-[10px] text-muted-foreground">{d?.plc_at ? `PLC ${new Date(d.plc_at).toLocaleTimeString("fi-FI")}` : ""}</span>
      </div>
      {!live && <div className="rounded border border-amber-600/50 bg-amber-600/10 px-2 py-1 text-amber-400">
        {d && !d.stale ? "Sequence/CircPump ei löydy OPC UA:sta" : "Ei dataa bridgeltä (Sensors/PLC_2/Sequence)"} – näytetään vain Myko-asetukset.</div>}

      <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-secondary/20 px-2 py-1.5" data-testid="seq-run-bar">
        <span className={`rounded px-2 py-0.5 font-semibold ${running ? "bg-emerald-600/25 text-emerald-300" : "bg-zinc-600/40 text-zinc-300"}`}>
          {plcEnable === undefined ? "—" : running ? "Käynnissä" : "Pysäytetty"}
        </span>
        <span>Askel <b>{step ?? "–"}</b>{step !== undefined ? ` (${STEPS.find(([n]) => n === step)?.[1] ?? ""})` : ""}</span>
        <span>HB {b(live ? p.HB_OK as boolean : undefined, "OK", "PUUTTUU", false)}</span>
        <span>Vuoto {b(live ? !(p.LeakAlarm as boolean) : undefined, "ei", "HÄLYTYS")}</span>
        <span title="Pumput_DB/Static/LVL (Float %)">Pinta <b>{tankFromTank !== undefined ? `${tankFromTank.toFixed(1)} %` : "–"}</b></span>
        {snapLevel !== undefined && <span className="text-muted-foreground" title="Sequence/Level (tallenne askel 3)">tallenne {snapLevel.toFixed(1)}</span>}
        <Button size="sm" variant={running ? "destructive" : "default"} className="ml-auto h-7 px-3"
          disabled={!live || plcEnable === undefined || !d?.seq_enable_write_allowed || seqBusy}
          title={d?.seq_enable_write_allowed ? "Kirjoittaa Sequence/Enable PLC:hen (vahvistus)" : "Kirjoitus ei käytössä"}
          data-testid="seq-start-stop"
          onClick={() => void toggleSeq(!plcEnable)}>
          {seqBusy ? "…" : running || plcEnable ? "Pysäytä" : "Käynnistä"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {STEPS.map(([n, t]) => (
          <div key={n} className={`flex-1 min-w-[90px] rounded border px-2 py-1 ${step === n ? "border-sky-400 bg-sky-500/20 text-sky-200" : "border-border text-muted-foreground"}`}>
            <div className="text-[10px]">Askel {n}</div><div className="font-medium">{t}</div>
            {step === n && rem !== undefined && <div className="text-[11px]">jäljellä {mmss(rem)}</div>}
          </div>))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>Tila {b(live ? !(p.Stopped as boolean) : undefined, "käy", "PYSÄYTETTY")}</span>
        <span>Syklit <b>{live ? (p.CycleCount as number ?? "–") : "–"}</b></span>
        <span>Askelaika <b>{live && p.StepTime_ms !== undefined ? mmss(p.StepTime_ms as number) : "–"}</b></span>
        <span>Enable {b(plcEnable, "ON", "OFF")}</span>
      </div>
      <div className="grid grid-cols-2 gap-2" data-testid="circ-pumps">
        {(["L", "R"] as const).map((sd) => {
          const st = live ? pumpState(p, sd) : { label: "–", kind: "idle" as const };
          const en = live ? (p[`${sd}_Enable`] as boolean | undefined) : undefined;
          const errCode = live ? (p[`${sd}_ErrCode`] as number | undefined) : undefined;
          const rt = live ? (p[`${sd}_RunTime_ms`] as number | undefined) : undefined;
          const starts = live ? (p[`${sd}_StartCount`] as number | undefined) : undefined;
          const skipped = live ? p[`${sd}_Skipped`] === true : false;
          return (
            <div key={sd} className="rounded border border-border px-2 py-1">
              <div className="mb-1 flex items-center gap-2 font-medium">
                Kiertopumppu {sd === "L" ? "vasen" : "oikea"}
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${stCls[st.kind]}`}>{st.label}</span>
                {skipped && <span className="rounded bg-amber-600/20 px-1 text-amber-300">ohitettu</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                <span>Käyttö {b(en, "ON", "OFF")}</span>
                <span>Vikakoodi <b>{errCode === undefined ? "–" : ERR[errCode] ?? errCode}</b></span>
                <span>Käynti <b>{rt !== undefined ? mmss(rt) : "–"}</b></span>
                <span>Käynnistyksiä <b>{starts ?? "–"}</b></span>
                <Button size="sm" variant={en ? "outline" : "default"} className="ml-auto h-6 px-2 text-[11px]"
                  disabled={!live || en === undefined || !d?.pump_write_allowed || pumpBusy === sd}
                  title={d?.pump_write_allowed ? "Kirjoittaa CircPump Enable PLC:hen (vahvistus)" : "Kirjoitus ei käytössä"}
                  onClick={() => void togglePump(sd, !en)}>{en ? "Off" : "On"}</Button>
              </div>
            </div>);
        })}
      </div>
      {f && <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
        {([["t_circ_s", "T_Circ (kierrätys)", p.T_Circ], ["t_settle_s", "T_Settle (tasaantuminen)", p.T_Settle], ["t_fill_s", "T_Fill (täyttö)", p.T_Fill]] as const).map(([k, l, pv]) => (
          <div key={k} className="contents">
            <label htmlFor={`seq-${k}`}>{l}</label>
            <input id={`seq-${k}`} type="number" min={1} className="h-7 rounded border border-border bg-background px-2" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            <span className="text-muted-foreground">s · PLC {live && pv !== undefined ? `${Math.round(Number(pv) / 1000)} s` : "–"}</span>
          </div>))}
      </div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving || !f}>Tallenna ajat</Button>
        <span className="text-[11px] text-muted-foreground">Käynnistä/Pysäytä → Sequence.Enable. CircPump On/Off → Enable. Ajat vain Mykoon. Ei Enable-synkkaa käynnistyksessä.</span>
      </div>
    </div>
  );
}
