import { useEffect, useState, type ReactNode } from "react";
import { getPid, sendPidCommand, type PidCommand, type PidValues } from "@/lib/apiClient";
import { toast } from "sonner";

/** ISA-101 PID faceplate parts for an S7 PID_Temp exposed via OPC UA (opcua-bridge). Gray when normal, colour only when abnormal. */
export const PID_KEY_BY_POINT: Record<string, string> = { ColdStorage1: "F1" };

export const PID_STATE: Record<number, string> = {
  0: "Ei aktiivinen", 1: "Esiviritys", 2: "Hienoviritys", 3: "Automaatti", 4: "Käsiajo", 5: "Korvaava lähtö",
};
const STATE_SHORT: Record<number, string> = { 0: "INAKT", 1: "ESIVIR", 2: "HIENOVIR", 3: "AUTO", 4: "KÄSI", 5: "KORV" };
export const PID_WARN_BITS: [number, string][] = [
  [0x1, "Käännepistettä ei löytynyt (viritys)"],
  [0x4, "Asetusarvo rajoitettu"],
  [0x8, "TIR-sääntö 3 käytössä"],
  [0x10, "Toimintatilan vaihto estetty"],
  [0x20, "OB-sykli rajoittaa näytteenottoaikaa"],
  [0x40, "Prosessiarvo varoitusrajalla"],
  [0x80, "Virheellinen Mode"],
  [0x100, "Käsiarvo rajoitettu"],
  [0x200, "Viritys­sääntöä ei tueta"],
  [0x1000, "Korvaava lähtöarvo rajojen ulkopuolella"],
  [0x4000, "Lähdön valintaa ei tueta"],
  [0x40000, "Virheellinen vahvistus / jäähdytyskerroin"],
];
const hex = (n: number | undefined) => (n === undefined ? "—" : `16#${(n >>> 0).toString(16).toUpperCase().padStart(4, "0")}`);
const f1 = (x: number | undefined, d = 1) => (x === undefined || x === null || Number.isNaN(x) ? "—" : x.toFixed(d).replace(".", ","));
const TINT = { heat: "text-[#d9b08f]", cool: "text-[#a9c8e8]", on: "text-[#a8d5b5]" };
const BAR = { heat: "bg-[#d9b08f]/70", cool: "bg-[#a9c8e8]/70" };

/** Polls the bridge state (backend caches the MQTT message). Stale after 15 s without data. */
export function usePid(key: string | undefined, intervalMs = 2000) {
  const [v, setV] = useState<Partial<PidValues> | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!key) return;
    let stop = false;
    const load = () => getPid(key).then((r) => { if (!stop) { setV(r.values); setAt(r.at); } }).catch(() => undefined);
    load();
    const t = setInterval(load, intervalMs);
    return () => { stop = true; clearInterval(t); };
  }, [key, intervalMs, n]);
  const stale = !at || Date.now() - new Date(at).getTime() > 90_000;
  return { v, at, stale, refresh: () => setN((x) => x + 1) };
}

export type PidAbn = { level: "alarm" | "warn"; text: string }[];
export function pidAbnormal(v: Partial<PidValues> | null, stale: boolean): PidAbn {
  const out: PidAbn = [];
  if (!v || stale) return [{ level: "warn", text: "Ei PID-dataa (OPC UA)" }];
  // Error=1: active PID error (priority 1). ErrorBits<>0 with Error=0: latched/auto-recovered bits waiting for ErrorAck (priority 2).
  if (v.Err) out.push({ level: "alarm", text: `PID-virhe ${hex(v.ErrBits)}` });
  else if ((v.ErrBits ?? 0) !== 0) out.push({ level: "warn", text: `ErrorBits ${hex(v.ErrBits)}` });
  if (v.State === 0) out.push({ level: "warn", text: "Säädin ei aktiivinen" });
  if (v.State === 5) out.push({ level: "warn", text: "Korvaava lähtö" });
  if (v.PVWarnH) out.push({ level: "warn", text: "PV yläraja" });
  if (v.PVWarnL) out.push({ level: "warn", text: "PV alaraja" });
  if (v.SPLimH || v.SPLimL) out.push({ level: "warn", text: "SP rajoitettu" });
  return out;
}

/** Split-range output bar: cool to the left, heat to the right of centre. */
export function OutputBar({ v }: { v: Partial<PidValues> }) {
  const heat = Math.max(0, Math.min(100, v.OutHeat ?? 0));
  const cool = Math.max(0, Math.min(100, v.OutCool ?? 0));
  return (
    <div data-testid="pid-outbar">
      <div className="relative h-2.5 w-full bg-zinc-700/60" aria-label="Lähtö">
        <div className={`absolute right-1/2 top-0 h-full ${BAR.cool}`} style={{ width: `${cool / 2}%` }} />
        <div className={`absolute left-1/2 top-0 h-full ${BAR.heat}`} style={{ width: `${heat / 2}%` }} />
        <div className="absolute left-1/2 top-[-2px] h-[14px] w-px bg-zinc-300" />
      </div>
      <div className="mt-0.5 flex justify-between text-xs tabular-nums text-muted-foreground">
        <span className={cool > 0 ? TINT.cool : ""}>COOL {f1(cool, 0)} %</span>
        <span>Σ {f1(v.OutSum, 0)} %</span>
        <span className={heat > 0 ? TINT.heat : ""}>HEAT {f1(heat, 0)} %</span>
      </div>
    </div>
  );
}

export function modeChip(v: Partial<PidValues> | null) {
  const s = v?.State;
  if (s === undefined) return { text: "—", cls: "text-muted-foreground" };
  const cls = s === 3 ? TINT.on : s === 4 ? "text-zinc-100 font-semibold" : s === 0 || s === 5 ? "text-amber-300 font-semibold" : "text-zinc-200";
  return { text: STATE_SHORT[s] ?? `TILA ${s}`, cls };
}

/** Compact faceplate rows for the widget card. */
export function PidCompact({ v, stale, unit }: { v: Partial<PidValues> | null; stale: boolean; unit: string }) {
  if (!v) return <div className="text-sm text-muted-foreground">PID: odotetaan dataa…</div>;
  const m = modeChip(v);
  return (
    <div className={`mt-1 space-y-1 ${stale ? "opacity-60" : ""}`} data-testid="pid-compact">
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums text-muted-foreground">
        <span className="hidden @[14rem]:inline">PV <span className="text-foreground">{f1(v.PV)}</span></span>
        <span>SP <span className="text-foreground">{f1(v.SP)}</span> {unit}</span>
        {v.CSP !== undefined && v.SP !== undefined && Math.abs(v.CSP - v.SP) > 0.05 && <span>CSP {f1(v.CSP)}</span>}
        <span className={m.cls} data-testid="pid-mode">{m.text}</span>
        {v.ManEn && <span className="text-zinc-100">MAN {f1(v.ManVal, 0)} %</span>}
      </div>
      <OutputBar v={v} />
    </div>
  );
}

/** Inline two-step confirm used for every write. */
function Confirm({ text, busy, onOk, onCancel }: { text: string; busy: boolean; onOk: () => void; onCancel: () => void }) {
  return (
    <div ref={(el) => el?.scrollIntoView({ block: "center", behavior: "smooth" })} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-400 bg-zinc-800/60 p-2" data-testid="pid-confirm">
      <span className="flex-1 text-sm font-semibold">{text}</span>
      <button type="button" disabled={busy} onClick={onOk} className="min-h-11 rounded-md border border-zinc-300 bg-zinc-200 px-4 text-sm font-semibold text-zinc-900 disabled:opacity-50">Vahvista</button>
      <button type="button" disabled={busy} onClick={onCancel} className="min-h-11 rounded-md border border-border px-4 text-sm">Peruuta</button>
    </div>
  );
}

const Section = ({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) => (
  <div className="space-y-2 rounded-md border border-border p-2" data-testid={testid}>
    <div className="text-xs font-mono uppercase text-muted-foreground">{title}</div>
    {children}
  </div>
);
const BTN = "min-h-11 rounded-md border px-3 text-sm font-semibold disabled:opacity-40";
const BTN_OFF = "border-border bg-secondary/40 text-muted-foreground";
const BTN_ON = "border-zinc-300 bg-zinc-200 text-zinc-900";

type Pending = { text: string; run: () => Promise<unknown> } | null;

/** Säätö tab: setpoint (via the controls route -> status word + OPC UA), Auto/Manual, manual value, ErrorAck. */
export function PidControlTab({
  pidKey, v, unit, onSetpoint, refresh,
}: {
  pidKey: string; v: Partial<PidValues> | null; unit: string;
  onSetpoint: (sp: number) => Promise<boolean>; refresh: () => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [sp, setSp] = useState("");
  const [mv, setMv] = useState("");
  useEffect(() => { if (v?.SP !== undefined && !pending) setSp(f1(v.SP)); }, [v?.SP]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (v?.ManVal !== undefined && !pending) setMv(f1(v.ManVal)); }, [v?.ManVal]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <div className="text-xs italic text-muted-foreground">Ei PID-dataa.</div>;
  const lo = Math.max(0, v.InLo ?? 0), hi = Math.min(30, v.InHi ?? 30);
  const num = (s: string) => Number(s.replace(",", "."));
  const spN = Math.round(num(sp) * 10) / 10;
  const spOk = Number.isFinite(spN) && spN >= lo && spN <= hi;
  const mvN = Math.round(num(mv) * 10) / 10;
  const mvOk = Number.isFinite(mvN) && mvN >= -100 && mvN <= 100;
  const go = async () => {
    if (!pending) return;
    setBusy(true);
    try { await pending.run(); toast.success("Kirjoitettu PLC:lle"); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); setPending(null); setTimeout(refresh, 800); }
  };
  const cmd = (c: PidCommand) => () => sendPidCommand(pidKey, c);
  const manual = v.State === 4 || v.ManEn;
  return (
    <div className="space-y-3" data-testid="pid-control">
      {pending && <Confirm text={pending.text} busy={busy} onOk={go} onCancel={() => setPending(null)} />}
      <Section title="Asetusarvo (SP)" testid="pid-sp">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-label="SP −0,1" disabled={busy || !spOk} onClick={() => setSp(f1(Math.max(lo, spN - 0.1)))} className="h-11 w-11 rounded-md border border-border text-xl disabled:opacity-40">−</button>
          <input aria-label="Asetusarvo" inputMode="decimal" value={sp} disabled={busy} onChange={(e) => setSp(e.target.value)}
            className={`h-11 w-20 rounded-md border bg-background text-center text-lg tabular-nums ${spOk ? "border-input" : "border-red-500"}`} />
          <button type="button" aria-label="SP +0,1" disabled={busy || !spOk} onClick={() => setSp(f1(Math.min(hi, spN + 0.1)))} className="h-11 w-11 rounded-md border border-border text-xl disabled:opacity-40">+</button>
          <span className="text-sm text-muted-foreground">{unit}</span>
          <button type="button" disabled={busy || !spOk || spN === v.SP}
            onClick={() => setPending({ text: `Asetusarvo ${f1(v.SP)} → ${f1(spN)} ${unit}?`, run: async () => { if (!(await onSetpoint(spN))) throw new Error("Asetusarvon kirjoitus epäonnistui"); } })}
            className={`${BTN} ${BTN_ON}`}>Aseta…</button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Nyt PLC: SP {f1(v.SP)} · CSP {f1(v.CSP)} {unit} · sallittu {f1(lo)}…{f1(hi)} (0,1 askel). Kirjoitetaan OPC UA:lla PID_Temp_{pidKey}.Setpoint + tilasanan SP-bitit (pyöristetty).
        </div>
      </Section>
      <Section title="Toimintatila" testid="pid-mode-ctl">
        <div className="text-sm">Tila: <span className="font-semibold">{PID_STATE[v.State ?? -1] ?? v.State}</span> · ManualEnable {v.ManEn ? "1" : "0"}</div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || (v.State === 3 && !v.ManEn)} className={`${BTN} ${v.State === 3 && !v.ManEn ? BTN_ON : BTN_OFF}`}
            onClick={() => setPending({ text: "Vaihda AUTOMAATTI-tilaan?", run: async () => { if (v.ManEn) await cmd({ ManualEnable: false })(); if (v.State !== 3) await cmd({ Mode: 3, ModeActivate: true })(); } })}>Auto</button>
          <button type="button" disabled={busy || manual} className={`${BTN} ${manual ? BTN_ON : BTN_OFF}`}
            onClick={() => setPending({ text: `Vaihda KÄSIAJOLLE (lähtö ${f1(v.ManVal)} %)?`, run: cmd({ ManualEnable: true }) })}>Käsi</button>
          <button type="button" disabled={busy || v.State === 0} className={`${BTN} ${v.State === 0 ? BTN_ON : BTN_OFF}`}
            onClick={() => setPending({ text: "Aseta säädin EI AKTIIVINEN -tilaan (lähdöt 0)?", run: cmd({ Mode: 0, ModeActivate: true }) })}>Inaktiivi</button>
        </div>
      </Section>
      <Section title="Käsiarvo (−100…100 %)" testid="pid-manval">
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Käsiarvo" inputMode="decimal" value={mv} disabled={busy} onChange={(e) => setMv(e.target.value)}
            className={`h-11 w-20 rounded-md border bg-background text-center text-lg tabular-nums ${mvOk ? "border-input" : "border-red-500"}`} />
          <span className="text-sm text-muted-foreground">%</span>
          <button type="button" disabled={busy || !mvOk || mvN === v.ManVal} className={`${BTN} ${BTN_ON}`}
            onClick={() => setPending({ text: `Käsiarvo ${f1(v.ManVal)} → ${f1(mvN)} %?`, run: cmd({ ManualValue: mvN }) })}>Aseta…</button>
        </div>
        <div className="text-[11px] text-muted-foreground">Vaikuttaa lähtöön vain käsiajolla. + = lämmitys, − = jäähdytys.</div>
      </Section>
      <Section title="Virheet" testid="pid-ack">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm ${v.Err ? "font-semibold text-red-400" : v.ErrBits ? "font-semibold text-amber-300" : "text-muted-foreground"}`}>ErrorBits {hex(v.ErrBits)}</span>
          <button type="button" disabled={busy} className={`${BTN} ${v.ErrBits || v.Warn ? "border-amber-400 bg-amber-400/15 text-amber-200" : BTN_OFF}`}
            onClick={() => setPending({ text: "Kuittaa PID-virheet (ErrorAck)?", run: cmd({ ErrorAck: true }) })}>Kuittaa (ErrorAck)</button>
        </div>
      </Section>
    </div>
  );
}

const Row = ({ k, val, abn }: { k: string; val: ReactNode; abn?: boolean }) => (
  <div className="flex gap-2 border-b border-border/50 py-1">
    <span className="w-40 shrink-0 text-muted-foreground">{k}</span>
    <span className={`tabular-nums ${abn ? "font-semibold text-amber-300" : ""}`}>{val}</span>
  </div>
);

export function PidStateTab({ v, at, unit }: { v: Partial<PidValues> | null; at: string | null; unit: string }) {
  if (!v) return <div className="text-xs italic text-muted-foreground">Ei PID-dataa.</div>;
  const warn = v.Warn ?? 0;
  return (
    <div className="space-y-3 text-sm" data-testid="pid-state">
      <div>
        <Row k="State" val={`${v.State} · ${PID_STATE[v.State ?? -1] ?? "?"}`} abn={v.State === 0 || v.State === 5} />
        <Row k="Mode" val={`${v.Mode} · ${PID_STATE[v.Mode ?? -1] ?? "?"}`} />
        <Row k="PV (Input / Scaled)" val={`${f1(v.PV, 2)} / ${f1(v.ScPV, 2)} ${unit}`} abn={v.PVWarnH || v.PVWarnL} />
        <Row k="SP / CurrentSetpoint" val={`${f1(v.SP)} / ${f1(v.CSP)} ${unit}`} abn={v.SPLimH || v.SPLimL} />
        <Row k="Disturbance" val={f1(v.Dist, 2)} />
        <Row k="PidOutputSum" val={`${f1(v.OutSum)} %`} />
        <Row k="OutputHeat / Cool" val={`${f1(v.OutHeat)} % / ${f1(v.OutCool)} %`} />
        <Row k="ManualEnable / Value" val={`${v.ManEn ? 1 : 0} / ${f1(v.ManVal)} %`} />
        <Row k="Jäähdytys" val={`ActivateCooling ${v.ActCool ? 1 : 0} · DisableCooling ${v.DisCool ? 1 : 0}`} abn={v.DisCool} />
        <Row k="Input-rajat" val={`${f1(v.InLo)} … ${f1(v.InHi)} ${unit}`} />
        <Row k="Error" val={`${v.Err ? 1 : 0} · ErrorBits ${hex(v.ErrBits)}`} abn={v.Err || (v.ErrBits ?? 0) !== 0} />
        <Row k="Warning" val={hex(warn)} />
      </div>
      <div data-testid="pid-warnbits">
        <div className="mb-1 text-xs font-mono uppercase text-muted-foreground">Varoitusbitit</div>
        {PID_WARN_BITS.map(([b, t]) => {
          const on = (warn & b) !== 0;
          return (
            <div key={b} className="flex items-center gap-2 py-0.5" data-on={on ? "1" : "0"}>
              <span className={`h-3 w-3 shrink-0 rounded-full border ${on ? "border-zinc-200 bg-zinc-200" : "border-zinc-600"}`} />
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{hex(b)}</span>
              <span className={on ? "" : "text-muted-foreground"}>{t}</span>
            </div>
          );
        })}
        {warn & ~PID_WARN_BITS.reduce((a, [b]) => a | b, 0) ? <div className="text-xs text-muted-foreground">Muut bitit: {hex(warn & ~PID_WARN_BITS.reduce((a, [b]) => a | b, 0))}</div> : null}
      </div>
      <div className="text-xs text-muted-foreground">OPC UA · päivitetty {at ? new Date(at).toLocaleTimeString("fi-FI", { timeZone: "Europe/Helsinki" }) : "—"}</div>
    </div>
  );
}

export function PidParamsTab({ v }: { v: Partial<PidValues> | null }) {
  if (!v) return <div className="text-xs italic text-muted-foreground">Ei PID-dataa.</div>;
  const rows: [string, number | undefined, number | undefined, string][] = [
    ["Vahvistus (Gain)", v.HGain, v.CGain, ""], ["Integrointiaika Ti", v.HTi, v.CTi, "s"],
    ["Derivointiaika Td", v.HTd, v.CTd, "s"], ["Säätöjakso (Cycle)", v.HCyc, v.CCyc, "s"],
  ];
  return (
    <div className="space-y-2 text-sm" data-testid="pid-params">
      <table className="w-full tabular-nums">
        <thead><tr className="text-left text-xs uppercase text-muted-foreground"><th className="py-1 font-normal">Parametri</th><th className="font-normal text-[#d9b08f]">Lämmitys</th><th className="font-normal text-[#a9c8e8]">Jäähdytys</th></tr></thead>
        <tbody>
          {rows.map(([k, h, c, u]) => (
            <tr key={k} className="border-b border-border/50"><td className="py-1.5 text-muted-foreground">{k}</td><td>{f1(h, 3)} {u}</td><td>{f1(c, 3)} {u}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="text-[11px] text-muted-foreground">Vain luku (Retain.CtrlParams). Viritys TIA Portalissa.</div>
    </div>
  );
}
