import { useEffect, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Info, X } from "lucide-react";
import { getPid, getPvFeed, sendPidCommand, setPvFeed, type PvFeedResponse, type PidCommand, type PidStatus, type PidValues } from "@/lib/apiClient";
import { toast } from "sonner";
import { ERROR_BITS, STATES, WARNING_BITS, activeCodes, hex, unknownBits, type Code } from "./pidCodes";

/** ISA-101 PID faceplate parts for S7 PID_Temp instances exposed via OPC UA (opcua-bridge). Gray when normal, colour only when abnormal. */
export const PID_KEY_BY_POINT: Record<string, string> = { ColdStorage1: "F1", Terrario1: "T1" };
export const PID_STATE: Record<number, string> = Object.fromEntries(STATES.map((s) => [s.v, s.title]));
const STATE_SHORT: Record<number, string> = { 0: "INAKT", 1: "ESIVIR", 2: "HIENOVIR", 3: "AUTO", 4: "KÄSI", 5: "KORV" };
const f1 = (x: number | undefined, d = 1) => (x === undefined || x === null || Number.isNaN(x) ? "—" : x.toFixed(d).replace(".", ","));
const TINT = { heat: "text-[#d9b08f]", cool: "text-[#a9c8e8]", on: "text-[#a8d5b5]" };
const BAR = { heat: "bg-[#d9b08f]/70", cool: "bg-[#a9c8e8]/70" };
const PID_ALARM: Record<string, { level: "alarm" | "warn"; text: string }> = {
  EI_AUTO: { level: "alarm", text: "Ei automaatilla" },
  PID_VIKA: { level: "alarm", text: "PID-vika" },
  ERRORBITS: { level: "warn", text: "ErrorBits" },
  OPCUA: { level: "warn", text: "Ei PID-dataa" },
  SATUROITUNUT: { level: "warn", text: "Lähtö saturoitunut" },
  SENSOR_VIKA: { level: "alarm", text: "Anturivika (PV-syöttö)" },
  INPUT_STALE: { level: "alarm", text: "Mittaus ei päivity PLC:lle" },
  ANTURIVIKA_ALASAJO: { level: "alarm", text: "P1 ANTURIVIKA – ajettu alas (ON pois)" },
};

export type Pid = { v: Partial<PidValues> | null; at: string | null; stale: boolean; s: PidStatus | null; refresh: () => void };
/** Polls the backend cache of the bridge state. `trend` also fetches the in-memory mini trend. */
export function usePid(key: string | undefined, intervalMs = 2000, trend = false): Pid {
  const [s, setS] = useState<PidStatus | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!key) return;
    let stop = false;
    let i = 0;
    const load = () => getPid(key, trend && i++ % 15 === 0).then((r) => { if (!stop) setS((o) => ({ ...r, trend: r.trend ?? o?.trend })); }).catch(() => undefined);
    load();
    const t = setInterval(load, intervalMs);
    return () => { stop = true; clearInterval(t); };
  }, [key, intervalMs, n, trend]);
  const at = s?.at ?? null;
  const stale = !at || Date.now() - new Date(at).getTime() > 60_000;
  return { v: s?.values ?? null, at, stale, s, refresh: () => setN((x) => x + 1) };
}

export type PidAbn = { level: "alarm" | "warn"; text: string }[];
/** Abnormal states shown on the card: backend PID alarm points (debounced), plus raw stale data. */
export function pidAbnormal(p: Pid): PidAbn {
  const out: PidAbn = (p.s?.active ?? []).map((k) => {
    const a = PID_ALARM[k] ?? { level: "warn" as const, text: k };
    return k === "ERRORBITS" ? { ...a, text: `ErrorBits ${hex(p.v?.ErrBits)}` } : k === "PID_VIKA" ? { ...a, text: `PID-vika ${hex(p.v?.ErrBits)}` } : a;
  });
  if (p.stale && !out.some((a) => a.text === PID_ALARM.OPCUA.text)) out.push({ level: "warn", text: PID_ALARM.OPCUA.text });
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
      <div className="mt-0.5 flex justify-between gap-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        <span className={cool > 0 ? TINT.cool : ""}>C<span className="hidden @[13rem]:inline">OOL</span> {f1(cool, 0)}%</span>
        <span className="hidden @[11rem]:inline">Σ {f1(v.OutSum, 0)}%</span>
        <span className={heat > 0 ? TINT.heat : ""}>H<span className="hidden @[13rem]:inline">EAT</span> {f1(heat, 0)}%</span>
      </div>
    </div>
  );
}

/** ISA-101 mode indication when State != 3: outline colour (edge, so alarm rings stay visible inside) + full-width banner.
 * cyan = operator modes (manual/inactive), violet = tuning, red = substitute output / error, grey = no OPC UA data. */
export type PidModeInd = { text: string; outline: string; banner: string } | null;
export function pidModeIndication(p: Pid): PidModeInd {
  const v = p.v;
  if (p.stale || !v) return { text: "EI YHTEYTTÄ", outline: "outline outline-[3px] -outline-offset-[3px] outline-zinc-400", banner: "bg-zinc-600 text-zinc-50" };
  const s = v.State;
  if (s === 3 || s === undefined) return null;
  const pct = (x: number | undefined) => `${f1(x, 0)} %`;
  const err = s === 5 || (s === 0 && v.Err === true);
  const cls = err ? ["outline-red-500", "bg-red-600 text-white"] : s === 1 || s === 2 ? ["outline-violet-400", "bg-violet-600 text-white"] : ["outline-cyan-400", "bg-cyan-600 text-white"];
  const text = s === 0 ? (v.Err ? "INAKTIIVI (VIKA)" : "INAKTIIVI") : s === 1 ? `ESIVIRITYS ${pct(v.Prog)}` : s === 2 ? `HIENOVIRITYS ${pct(v.Prog)}` : s === 4 ? `MANUAALI ${pct(v.ManVal)}` : s === 5 ? "KORVAAVA ARVO" : `TILA ${s}`;
  return { text, outline: `outline outline-[3px] -outline-offset-[3px] ${cls[0]}`, banner: cls[1] };
}
export function PidModeBanner({ ind, className = "" }: { ind: PidModeInd; className?: string }) {
  if (!ind) return null;
  return (
    <div role="status" data-testid="pid-mode-banner" className={`w-full truncate rounded-sm px-2 py-1 text-center text-base font-bold uppercase tracking-wide tabular-nums ${ind.banner} ${className}`}>{ind.text}</div>
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

/** Modal confirm for every PLC write: centred, dimmed backdrop, above the faceplate popup (z-[60]). */
function ConfirmDialog({ pending, busy, onOk, onCancel }: { pending: Pending; busy: boolean; onOk: () => void; onCancel: () => void }) {
  return (
    <DialogPrimitive.Root open={Boolean(pending)} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/75" />
        <DialogPrimitive.Content
          data-testid="pid-confirm"
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-400 bg-background p-4 shadow-2xl"
        >
          <DialogPrimitive.Title className="text-xs font-mono uppercase text-muted-foreground">Vahvista kirjoitus PLC:lle</DialogPrimitive.Title>
          <div className="mt-2 text-base font-semibold">{pending?.text}</div>
          {pending?.detail && <div className="mt-1 text-sm text-muted-foreground">{pending.detail}</div>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={onCancel} className="min-h-11 rounded-md border border-border px-4 text-sm">Peruuta</button>
            <button type="button" disabled={busy} onClick={onOk} autoFocus className="min-h-11 rounded-md border border-zinc-300 bg-zinc-200 px-5 text-sm font-semibold text-zinc-900 disabled:opacity-50">
              {busy ? "Kirjoitetaan…" : "Vahvista"}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** ⓘ button + dialog: active ErrorBits/Warning bits decoded (meaning, cause, fix) and the full reference. */
export function CodeInfo({ v, focus }: { v: Partial<PidValues>; focus: "err" | "warn" | "state" }) {
  const [open, setOpen] = useState(false);
  const errs = activeCodes(ERROR_BITS, v.ErrBits);
  const warns = activeCodes(WARNING_BITS, v.Warn);
  const uE = unknownBits(ERROR_BITS, v.ErrBits), uW = unknownBits(WARNING_BITS, v.Warn);
  const item = (c: Code, kind: "err" | "warn", on: boolean) => (
    <li key={kind + c.bit} className={`border-l-2 py-1 pl-2 ${on ? (kind === "err" ? (v.Err ? "border-red-500" : "border-amber-400") : "border-zinc-300") : "border-zinc-700"}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs text-muted-foreground">{hex(c.bit)}</span>
        <span className={on ? "font-semibold" : ""}>{c.title}</span>
        <span className="text-[11px] text-muted-foreground">{kind === "err" ? "kuittaus ErrorAck" : c.auto ? "poistuu itsestään" : "kuittaus ErrorAck/Reset"}</span>
      </div>
      {on && <div className="text-xs text-muted-foreground"><b className="text-foreground">Syy:</b> {c.cause}</div>}
      {on && <div className="text-xs text-muted-foreground"><b className="text-foreground">Korjaus:</b> {c.fix}</div>}
    </li>
  );
  const ref = (t: string, codes: Code[], kind: "err" | "warn") => (
    <details className="rounded-md border border-border p-2" open={false}>
      <summary className="min-h-9 cursor-pointer text-sm font-semibold">{t} – kaikki koodit</summary>
      <ul className="mt-1 space-y-1">{codes.map((c) => (
        <li key={c.bit} className="text-xs"><span className="font-mono text-muted-foreground">{hex(c.bit)}</span> {c.title} — <span className="text-muted-foreground">{c.cause} {c.fix}</span>{kind === "warn" && c.auto ? " (poistuu itsestään)" : ""}</li>
      ))}</ul>
    </details>
  );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Selitys" data-testid={`pid-info-${focus}`}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground">
        <Info className="h-[18px] w-[18px]" />
      </button>
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/75" />
          <DialogPrimitive.Content data-testid="pid-info" aria-describedby={undefined}
            className="fixed inset-0 z-[61] flex flex-col bg-background md:inset-auto md:left-1/2 md:top-1/2 md:max-h-[85vh] md:w-[min(92vw,640px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:border md:border-zinc-500">
            <div className="flex items-center gap-2 border-b border-border p-3">
              <DialogPrimitive.Title className="flex-1 text-lg font-semibold">PID-tila ja vikakoodit</DialogPrimitive.Title>
              <DialogPrimitive.Close aria-label="Sulje" className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"><X className="h-5 w-5" /></DialogPrimitive.Close>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
              <div>
                <div className="text-xs font-mono uppercase text-muted-foreground">State {v.State}</div>
                <ul className="mt-1 space-y-0.5">{STATES.map((s) => (
                  <li key={s.v} className={`text-xs ${s.v === v.State ? "text-foreground" : "text-muted-foreground"}`}>
                    <span className="font-mono">{s.v}</span> <b className={s.v === v.State ? "" : "font-normal"}>{s.title}</b> — {s.help}
                  </li>
                ))}</ul>
              </div>
              <div>
                <div className="text-xs font-mono uppercase text-muted-foreground">ErrorBits {hex(v.ErrBits)} · Error {v.Err ? 1 : 0}</div>
                {errs.length || uE ? <ul className="mt-1 space-y-1">{errs.map((c) => item(c, "err", true))}{uE ? <li className="text-xs">Tuntemattomat bitit {hex(uE)}</li> : null}</ul>
                  : <div className="text-muted-foreground">Ei virheitä.</div>}
                <div className="mt-1 text-[11px] text-muted-foreground">ErrorBits jäävät päälle kunnes ErrorAck (tai Reset) nousevalla reunalla. Error=1 tarkoittaa että vika on yhä voimassa – korjaa syy ennen kuittausta.</div>
              </div>
              <div>
                <div className="text-xs font-mono uppercase text-muted-foreground">Warning {hex(v.Warn)}</div>
                {warns.length || uW ? <ul className="mt-1 space-y-1">{warns.map((c) => item(c, "warn", true))}{uW ? <li className="text-xs">Tuntemattomat bitit {hex(uW)}</li> : null}</ul>
                  : <div className="text-muted-foreground">Ei varoituksia.</div>}
              </div>
              {ref("ErrorBits", ERROR_BITS, "err")}
              {ref("Warning", WARNING_BITS, "warn")}
              <div className="text-[11px] text-muted-foreground">Lähde: Siemens TIA Portal V20 -ohje, PID_Temp ErrorBits / Warning.</div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

/** Mini trend (in-memory, 30 s samples, up to 6 h): PV solid, SP dashed, output as faint area (±100 %). */
export function MiniTrend({ data, unit }: { data: NonNullable<PidStatus["trend"]>; unit: string }) {
  const pts = data.filter((d) => Number.isFinite(d.pv));
  if (pts.length < 3) return <div className="text-[11px] text-muted-foreground">Minitrendi kertyy (30 s välein, max 6 h).</div>;
  const W = 300, H = 64;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const ys = pts.flatMap((d) => [d.pv!, d.sp ?? d.pv!]);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  const yo = (o: number) => H / 2 - (o / 100) * (H / 2 - 1);
  const line = (k: "pv" | "sp") => pts.map((d, i) => `${i ? "L" : "M"}${x(d.t).toFixed(1)},${y((d[k] ?? d.pv)!).toFixed(1)}`).join("");
  const area = `M0,${H / 2}` + pts.map((d) => `L${x(d.t).toFixed(1)},${yo(d.out ?? 0).toFixed(1)}`).join("") + `L${W},${H / 2}Z`;
  const mins = Math.round((t1 - t0) / 60000);
  return (
    <div data-testid="pid-trend">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-16 w-full">
        <path d={area} className="fill-zinc-500/20" />
        <path d={line("sp")} className="fill-none stroke-zinc-400" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <path d={line("pv")} className="fill-none stroke-zinc-100" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>−{mins >= 60 ? `${f1(mins / 60)} h` : `${mins} min`}</span>
        <span>PV — · SP - - · lähtö ▒ · {f1(lo)}…{f1(hi)} {unit}</span>
        <span>nyt</span>
      </div>
    </div>
  );
}

const Section = ({ title, children, testid, right }: { title: string; children: ReactNode; testid?: string; right?: ReactNode }) => (
  <div className="space-y-2 rounded-md border border-border p-2" data-testid={testid}>
    <div className="flex items-center gap-2"><div className="flex-1 text-xs font-mono uppercase text-muted-foreground">{title}</div>{right}</div>
    {children}
  </div>
);
const BTN = "min-h-11 rounded-md border px-3 text-sm font-semibold disabled:opacity-40";
const BTN_OFF = "border-border bg-secondary/40 text-muted-foreground";
const BTN_ON = "border-zinc-300 bg-zinc-200 text-zinc-900";

type Pending = { text: string; detail?: string; run: () => Promise<unknown> } | null;

const ago = (t: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} s sitten` : "—");
/** Mittauslähde: Myko reads a selectable MQTT sensor field, filters it and (only when switched ON) writes PID_Temp.Input. */
function FeedSection({ pidKey, unit }: { pidKey: string; unit: string }) {
  const [d, setD] = useState<PvFeedResponse | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState("");
  const load = () => getPvFeed(pidKey).then(setD).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [pidKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = d?.feed;
  const cur = f?.topic && f.field ? `${f.topic}|${f.field}` : "";
  useEffect(() => { if (!pending) setSel(cur); }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return null;
  const go = async () => {
    if (!pending) return;
    setBusy(true);
    try { await pending.run(); toast.success("Tallennettu"); await load(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); setPending(null); }
  };
  const srcs = (d?.sources ?? []).filter((s) => !s.topic.startsWith("Sensors/PLC_2"));
  if (cur && !srcs.some((s) => `${s.topic}|${s.field}` === cur)) srcs.unshift({ topic: f.topic!, field: f.field!, value: NaN, at: "" });
  const label = (t: string | null, fl: string | null) => (t && fl ? `${t.replace(/^Sensors\//, "")} · ${fl}` : "ei valittu");
  const val = (x: number) => (d?.codes?.[String(x)] ? `${x} (${d.codes[String(x)]})` : f1(x, 2));
  const alarm = f.alarms?.SENSOR_VIKA || f.alarms?.INPUT_STALE;
  return (
    <Section title="Mittauslähde (Myko → PID Input)" testid="pid-feed">
      <ConfirmDialog pending={pending} busy={busy} onOk={go} onCancel={() => { setPending(null); setSel(cur); }} />
      <label className="block text-[11px] text-muted-foreground">Lähde (MQTT-aihe · kenttä)</label>
      <select aria-label="Mittauslähde" value={sel} disabled={busy} data-testid="pid-feed-src"
        onChange={(e) => {
          const nv = e.target.value; setSel(nv);
          if (nv === cur) return;
          const [t, fl] = nv ? nv.split("|") : [null, null];
          setPending({
            text: `Vaihda ${pidKey}:n mittauslähde: ${label(f.topic, f.field)} → ${label(t, fl)}?`,
            detail: f.enabled ? "Syöttö on PÄÄLLÄ: PLC:n PID-mittaus vaihtuu heti uuteen anturiin." : "Syöttö on pois päältä – PLC:lle ei kirjoiteta ennen kuin kytket syötön päälle.",
            run: () => setPvFeed(pidKey, { topic: t, field: fl }),
          });
        }}
        className="h-11 w-full rounded-md border border-input bg-background px-2 text-sm">
        <option value="">— ei valittu —</option>
        {srcs.map((s) => (
          <option key={`${s.topic}|${s.field}`} value={`${s.topic}|${s.field}`}>
            {label(s.topic, s.field)}{Number.isFinite(s.value) ? ` = ${val(s.value)}` : ""}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" role="switch" aria-checked={f.enabled} data-testid="pid-feed-switch" disabled={busy || (!f.enabled && !cur)}
          onClick={() => setPending(f.enabled
            ? { text: "Lopeta Myko syöttää mittauksen?", detail: `PID_Temp_${pidKey}.Input jää viimeiseen kirjoitettuun arvoon (${f1(f.wrote ?? undefined, 2)} ${unit}) kunnes PLC tai Myko kirjoittaa sen.`, run: () => setPvFeed(pidKey, { enabled: false }) }
            : { text: `Kytke päälle: Myko syöttää mittauksen ${pidKey}:lle?`, detail: `Lähde ${label(f.topic, f.field)}. Hyväksytyt arvot kirjoitetaan PID_Temp_${pidKey}.Input (OPC UA, max 1/s, rajattu InLo…InHi). Varmista että PLC:n oma kirjoitus Inputiin on poistettu.`, run: () => setPvFeed(pidKey, { enabled: true }) })}
          className={`${BTN} ${f.enabled ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200" : BTN_OFF}`}>
          Myko syöttää mittauksen: {f.enabled ? "PÄÄLLÄ" : "POIS"}
        </button>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">Alasajo viasta
          <select aria-label="Alasajoviive" value={f.shutdownMin} disabled={busy} data-testid="pid-feed-shutdown"
            onChange={(e) => { const m = Number(e.target.value); setPending({ text: `Alasajoviive ${f.shutdownMin} → ${m} min?`, detail: "Jos anturivika tai Input-kirjoituksen katko kestää näin kauan (syöttö päällä), Myko kytkee pisteen ON pois (lämmitys ja jäähdytys seis), hälyttää P1 ANTURIVIKA_ALASAJO eikä käynnistä uudelleen automaattisesti.", run: () => setPvFeed(pidKey, { shutdownMin: m }) }); }}
            className="h-9 rounded-md border border-input bg-background px-1 text-sm">
            {[...new Set([1, 2, 5, 10, 15, 30, 60, f.shutdownMin])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
        {f.shutdown && <span className="rounded border border-red-500 bg-red-600/30 px-2 py-0.5 text-xs font-semibold text-red-100">AJETTU ALAS – kytke ON käsin</span>}
        {alarm && <span className="rounded border border-red-500/60 bg-red-500/15 px-2 py-0.5 text-xs text-red-200">{f.alarms.SENSOR_VIKA ? "ANTURIVIKA" : "EI PÄIVITY"}</span>}
      </div>
      <div className="grid grid-cols-2 gap-x-3 text-[11px] text-muted-foreground tabular-nums" data-testid="pid-feed-status">
        <span>Raaka: {f.lastRaw === null ? "—" : val(f.lastRaw)} ({ago(f.rawAt)})</span>
        <span>Hyväksytty: {f1(f.lastGood ?? undefined, 2)} {unit} ({ago(f.goodAt)})</span>
        <span>Kirjoitettu: {f.enabled ? `${f1(f.wrote ?? undefined, 2)} (${ago(f.wroteAt)}), ${f.writes} kpl` : "ei (syöttö pois)"}</span>
        <span>PLC Input: {f1(f.plcInput ?? undefined, 2)} {unit}</span>
        {f.faultSince && !f.shutdown && <span className="col-span-2 text-amber-300">Vika jatkunut {ago(f.faultSince).replace(" sitten", "")} – alasajo {f.shutdownMin} min kohdalla</span>}
        {f.reject && <span className="col-span-2">Viimeksi hylätty: {f.reject} ({ago(f.rejectAt)})</span>}
        {f.writeErr && <span className="col-span-2 text-red-300">Kirjoitusvirhe: {f.writeErr}</span>}
        <span className="col-span-2">Suodatus: ESP-koodit −127…−119, NaN, alue {f1(f.min)}…{f1(f.max)}, piikki &gt; {f1(f.maxStep)} {unit}/näyte (hyväksytään {f.confirmN} peräkkäisellä). Hälytys: anturivika {f.faultS} s, ei kirjoitusta {f.staleS} s.</span>
      </div>
    </Section>
  );
}

/** Säätö tab: setpoint (controls route -> status word + OPC UA), Auto/Manual, manual value, ErrorAck, mini trend, last commands. */
export function PidControlTab({
  pidKey, pid, unit, onSetpoint,
}: {
  pidKey: string; pid: Pid; unit: string; onSetpoint: (sp: number) => Promise<boolean>;
}) {
  const v = pid.v;
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
    finally { setBusy(false); setPending(null); setTimeout(pid.refresh, 800); }
  };
  const cmd = (c: PidCommand) => () => sendPidCommand(pidKey, c);
  const manual = v.State === 4 || v.ManEn;
  return (
    <div className="space-y-3" data-testid="pid-control">
      <ConfirmDialog pending={pending} busy={busy} onOk={go} onCancel={() => setPending(null)} />
      <Section title="Asetusarvo (SP)" testid="pid-sp">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-label="SP −0,1" disabled={busy || !spOk} onClick={() => setSp(f1(Math.max(lo, spN - 0.1)))} className="h-11 w-11 rounded-md border border-border text-xl disabled:opacity-40">−</button>
          <input aria-label="Asetusarvo" inputMode="decimal" value={sp} disabled={busy} onChange={(e) => setSp(e.target.value)}
            className={`h-11 w-20 rounded-md border bg-background text-center text-lg tabular-nums ${spOk ? "border-input" : "border-red-500"}`} />
          <button type="button" aria-label="SP +0,1" disabled={busy || !spOk} onClick={() => setSp(f1(Math.min(hi, spN + 0.1)))} className="h-11 w-11 rounded-md border border-border text-xl disabled:opacity-40">+</button>
          <span className="text-sm text-muted-foreground">{unit}</span>
          <button type="button" disabled={busy || !spOk}
            onClick={() => setPending({
              text: spN === v.SP ? `Kirjoita asetusarvo ${f1(spN)} ${unit} uudelleen PLC:lle?` : `Asetusarvo ${f1(v.SP)} → ${f1(spN)} ${unit}?`,
              detail: `PID_Temp_${pidKey}.Setpoint (OPC UA) + tilasanan SP-bitit (${Math.round(spN)}).`,
              run: async () => { if (!(await onSetpoint(spN))) throw new Error("Asetusarvon kirjoitus epäonnistui"); },
            })}
            className={`${BTN} ${BTN_ON}`}>Aseta…</button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          PLC: SP {f1(v.SP)} · CSP {f1(v.CSP)} {unit} · PV {f1(v.PV)} · sallittu {f1(lo)}…{f1(hi)} (0,1 askel).
        </div>
        {pid.s?.trend && <MiniTrend data={pid.s.trend} unit={unit} />}
      </Section>
      <FeedSection pidKey={pidKey} unit={unit} />
      <Section title="Toimintatila" testid="pid-mode-ctl" right={<CodeInfo v={v} focus="state" />}>
        <div className="text-sm">Tila: <span className="font-semibold">{PID_STATE[v.State ?? -1] ?? v.State}</span> · ManualEnable {v.ManEn ? "1" : "0"}{pid.s?.intended ? " · tahallinen (dashboard)" : ""}</div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || (v.State === 3 && !v.ManEn)} className={`${BTN} ${v.State === 3 && !v.ManEn ? BTN_ON : BTN_OFF}`}
            onClick={() => setPending({ text: "Vaihda AUTOMAATTI-tilaan?", detail: "ManualEnable=0 ja tarvittaessa Mode=3 + ModeActivate.", run: async () => { if (v.ManEn) await cmd({ ManualEnable: false })(); if (v.State !== 3) await cmd({ Mode: 3, ModeActivate: true })(); } })}>Auto</button>
          <button type="button" disabled={busy || manual} className={`${BTN} ${manual ? BTN_ON : BTN_OFF}`}
            onClick={() => setPending({ text: "Vaihda KÄSIAJOLLE?", detail: `Lähtö = käsiarvo ${f1(v.ManVal)} %. Ei hälytä (komento dashboardista).`, run: cmd({ ManualEnable: true }) })}>Käsi</button>
          <button type="button" disabled={busy || v.State === 0} className={`${BTN} ${v.State === 0 ? BTN_ON : BTN_OFF}`}
            onClick={() => setPending({ text: "Aseta säädin EI AKTIIVINEN -tilaan?", detail: "Lähdöt 0 %. Lämmitys ja jäähdytys pysähtyvät.", run: cmd({ Mode: 0, ModeActivate: true }) })}>Inaktiivi</button>
        </div>
      </Section>
      <TuningSection pidKey={pidKey} v={v} busy={busy} tuning={Boolean(pid.s?.tuning)} setPending={setPending} />
      <Section title="Käsiarvo (−100…100 %)" testid="pid-manval">
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Käsiarvo" inputMode="decimal" value={mv} disabled={busy} onChange={(e) => setMv(e.target.value)}
            className={`h-11 w-20 rounded-md border bg-background text-center text-lg tabular-nums ${mvOk ? "border-input" : "border-red-500"}`} />
          <span className="text-sm text-muted-foreground">%</span>
          <button type="button" disabled={busy || !mvOk || mvN === v.ManVal} className={`${BTN} ${BTN_ON}`}
            onClick={() => setPending({ text: `Käsiarvo ${f1(v.ManVal)} → ${f1(mvN)} %?`, detail: manual ? "Vaikuttaa lähtöön heti (käsiajo)." : "Vaikuttaa vasta käsiajolla.", run: cmd({ ManualValue: mvN }) })}>Aseta…</button>
        </div>
        <div className="text-[11px] text-muted-foreground">+ = lämmitys, − = jäähdytys.</div>
      </Section>
      <Section title="Virheet" testid="pid-ack" right={<CodeInfo v={v} focus="err" />}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm ${v.Err ? "font-semibold text-red-400" : v.ErrBits ? "font-semibold text-amber-300" : "text-muted-foreground"}`}>ErrorBits {hex(v.ErrBits)}</span>
          <span className="text-sm text-muted-foreground">Warning {hex(v.Warn)}{v.Warn ? " (info)" : ""}</span>
          <button type="button" disabled={busy} className={`${BTN} ${v.ErrBits || v.Err ? "border-amber-400 bg-amber-400/15 text-amber-200" : BTN_OFF}`}
            onClick={() => setPending({ text: "Kuittaa PID-virheet (ErrorAck)?", detail: "Nollaa ErrorBitsit ja kuitattavat varoitukset. Jos vika on yhä päällä (Error=1), bitti palaa.", run: cmd({ ErrorAck: true }) })}>Kuittaa (ErrorAck)</button>
        </div>
      </Section>
      {pid.s?.commands?.length ? (
        <Section title="Viimeiset komennot" testid="pid-cmds">
          <ul className="space-y-0.5 text-xs">{pid.s.commands.map((c, i) => (
            <li key={i} className="flex gap-2"><span className="w-24 shrink-0 tabular-nums text-muted-foreground">{new Date(c.at).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span>{c.alarm}</span></li>
          ))}</ul>
        </Section>
      ) : null}
    </div>
  );
}

/** Tuning (PID_Temp Mode 1 = pretuning, 2 = fine tuning; Mode 3 + ModeActivate cancels -> automatic).
 * Heat.EnableTuning / Cool.EnableTuning select what is tuned; exactly one is set true (fine tuning requires it). */
function TuningSection({ pidKey, v, busy, tuning, setPending }: {
  pidKey: string; v: Partial<PidValues>; busy: boolean; tuning: boolean; setPending: (p: Pending) => void;
}) {
  const [target, setTarget] = useState<"heat" | "cool">("heat");
  const running = v.State === 1 || v.State === 2;
  const coolOk = v.ActCool !== false;
  const WARN = "Viritys heiluttaa lämpötilaa tarkoituksella (askel-/värähtelykoe) ja voi kestää tunteja. Älä muuta asetusarvoa virityksen aikana. EI_AUTO-hälytys vaimennetaan virityksen ajaksi; jos viritys päättyy virheeseen, hälytys tulee.";
  const start = (mode: 1 | 2) => {
    const name = mode === 1 ? "ESIVIRITYS" : "HIENOVIRITYS";
    const tgt = target === "heat" ? "lämmitys" : "jäähdytys";
    const pre = mode === 1 ? (target === "heat" ? "Esiviritys vaatii PV:n selvästi SP:n alapuolelle ja jäähdytyksen pois päältä. " : "Jäähdytyksen esiviritys vaatii onnistuneen lämmityksen esivirityksen ja PV:n lähellä SP:tä. ") : "Hienoviritys tehdään asetusarvon ympärillä. ";
    setPending({
      text: `Käynnistä ${name} (${tgt}) säätimelle ${pidKey}?`,
      detail: `${target === "cool" ? "⚠ Jäähdytys on kompressori – viritystä ei suositella, voi käynnistellä kompuraa tiheään. " : ""}${pre}${WARN} Kirjoitetaan Heat.EnableTuning=${target === "heat" ? 1 : 0}, Cool.EnableTuning=${target === "cool" ? 1 : 0}, Mode=${mode} + ModeActivate.`,
      run: () => sendPidCommand(pidKey, { HeatEnableTuning: target === "heat", CoolEnableTuning: target === "cool", Mode: mode, ModeActivate: true }),
    });
  };
  return (
    <Section title="Viritys" testid="pid-tuning">
      <div className="text-sm">
        {running ? <span className="font-semibold text-amber-300">{v.State === 1 ? "Esiviritys" : "Hienoviritys"} käynnissä · {f1(v.Prog, 0)} %</span> : <span className="text-muted-foreground">Ei viritystä käynnissä</span>}
        {running && tuning ? <span className="text-muted-foreground"> · käynnistetty dashboardista</span> : null}
      </div>
      {running && (
        <div className="h-2 w-full bg-zinc-700/60" aria-label="Virityksen edistyminen" data-testid="pid-tune-progress">
          <div className="h-full bg-amber-300/70" style={{ width: `${Math.max(0, Math.min(100, v.Prog ?? 0))}%` }} />
        </div>
      )}
      <div className="text-[11px] text-muted-foreground">
        Kohde PLC:ssä: Heat.EnableTuning {v.HEnTune ? 1 : 0} · Cool.EnableTuning {v.CEnTune ? 1 : 0} · SUT.State {v.SUTSt ?? "—"} · TIR.State {v.TIRSt ?? "—"} · ProcPar OK H {v.SUTHOk ? 1 : 0}/C {v.SUTCOk ? 1 : 0}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Viritettävä">
        <span className="text-sm text-muted-foreground">Viritettävä:</span>
        <button type="button" role="radio" aria-checked={target === "heat"} disabled={busy || running} onClick={() => setTarget("heat")} className={`${BTN} ${target === "heat" ? BTN_ON : BTN_OFF}`}>Lämmitys</button>
        <button type="button" role="radio" aria-checked={target === "cool"} disabled={busy || running || !coolOk} onClick={() => setTarget("cool")} className={`${BTN} ${target === "cool" ? BTN_ON : BTN_OFF}`}>Jäähdytys</button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || running || v.ManEn} className={`${BTN} ${BTN_OFF}`} onClick={() => start(1)} data-testid="pid-tune-pre">Esiviritys…</button>
        <button type="button" disabled={busy || running || v.ManEn} className={`${BTN} ${BTN_OFF}`} onClick={() => start(2)} data-testid="pid-tune-fine">Hienoviritys…</button>
        <button type="button" disabled={busy || !running} className={`${BTN} ${running ? "border-amber-400 bg-amber-400/15 text-amber-200" : BTN_OFF}`} data-testid="pid-tune-cancel"
          onClick={() => setPending({ text: "Peru viritys ja palaa AUTOMAATTIIN?", detail: "Mode=3 + ModeActivate. Vanhat PID-parametrit säilyvät.", run: () => sendPidCommand(pidKey, { Mode: 3, ModeActivate: true }) })}>Peru viritys</button>
      </div>
      {v.ManEn ? <div className="text-[11px] text-amber-300">ManualEnable=1 estää tilanvaihdon – palaa ensin Autolle.</div> : null}
    </Section>
  );
}

const Row = ({ k, val, abn, extra }: { k: string; val: ReactNode; abn?: boolean; extra?: ReactNode }) => (
  <div className="flex min-h-8 items-center gap-2 border-b border-border/50 py-1">
    <span className="w-40 shrink-0 text-muted-foreground">{k}</span>
    <span className={`flex-1 tabular-nums ${abn ? "font-semibold text-amber-300" : ""}`}>{val}</span>
    {extra}
  </div>
);

export function PidStateTab({ v, at, unit }: { v: Partial<PidValues> | null; at: string | null; unit: string }) {
  if (!v) return <div className="text-xs italic text-muted-foreground">Ei PID-dataa.</div>;
  const warn = v.Warn ?? 0;
  const errs = activeCodes(ERROR_BITS, v.ErrBits);
  return (
    <div className="space-y-3 text-sm" data-testid="pid-state">
      <div>
        <Row k="State" val={`${v.State} · ${PID_STATE[v.State ?? -1] ?? "?"}`} abn={v.State !== 3} extra={<CodeInfo v={v} focus="state" />} />
        <Row k="Mode" val={`${v.Mode} · ${PID_STATE[v.Mode ?? -1] ?? "?"}`} />
        <Row k="PV (Input / Scaled)" val={`${f1(v.PV, 2)} / ${f1(v.ScPV, 2)} ${unit}`} abn={v.PVWarnH || v.PVWarnL} />
        <Row k="SP / CurrentSetpoint" val={`${f1(v.SP)} / ${f1(v.CSP)} ${unit}`} abn={v.SPLimH || v.SPLimL} />
        <Row k="Disturbance" val={f1(v.Dist, 2)} />
        <Row k="PidOutputSum" val={`${f1(v.OutSum)} %`} />
        <Row k="OutputHeat / Cool" val={`${f1(v.OutHeat)} % / ${f1(v.OutCool)} %`} />
        <Row k="ManualEnable / Value" val={`${v.ManEn ? 1 : 0} / ${f1(v.ManVal)} %`} />
        <Row k="Jäähdytys" val={`ActivateCooling ${v.ActCool ? 1 : 0} · DisableCooling ${v.DisCool ? 1 : 0}`} abn={v.DisCool} />
        <Row k="Input-rajat" val={`${f1(v.InLo)} … ${f1(v.InHi)} ${unit}`} />
        <Row k="ErrorBits" val={<>{hex(v.ErrBits)} · Error {v.Err ? 1 : 0}{errs.length ? <span className="block text-xs font-normal">{errs.map((c) => c.title).join(" · ")}</span> : null}</>}
          abn={v.Err || (v.ErrBits ?? 0) !== 0} extra={<CodeInfo v={v} focus="err" />} />
        <Row k="Warning" val={<>{hex(warn)}{warn ? <span className="block text-xs text-muted-foreground">{activeCodes(WARNING_BITS, warn).map((c) => c.title).join(" · ")}</span> : null}</>}
          extra={<CodeInfo v={v} focus="warn" />} />
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
      <div className="text-[11px] text-muted-foreground">Kuollut alue (DeadZone): lämmitys {f1(v.HDZ, 2)} · jäähdytys {f1(v.CDZ, 2)}</div>
      <div className="text-[11px] text-muted-foreground">Vain luku (Retain.CtrlParams). Viritys Säätö-välilehdeltä (Esi-/Hienoviritys).</div>
    </div>
  );
}
