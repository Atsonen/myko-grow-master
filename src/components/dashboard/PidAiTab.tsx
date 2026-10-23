import { useCallback, useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { getPidAi, getPidAiJob, markPidAiSeen, startPidAiAnalyze, startPidAiApply, startPidAiRestore, type PidAiJob, type PidAiState } from "@/lib/apiClient";

const fmtT = (s: string) => new Date(s).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
const num = (v: unknown) => (typeof v === "number" ? (Math.abs(v) >= 100 ? v.toFixed(1) : String(Number(v.toFixed(4)))) : String(v ?? "—"));
const RISK: Record<string, string> = { low: "bg-emerald-900/60 text-emerald-200", medium: "bg-amber-900/60 text-amber-200", high: "bg-red-900/70 text-red-200" };
const RISK_FI: Record<string, string> = { low: "matala riski", medium: "kohtalainen riski", high: "korkea riski" };
const NAME_FI: Record<string, string> = { Gain: "Vahvistus", Ti: "Ti (s)", Td: "Td (s)", TdFiltRatio: "Td-suodatin", PWeighting: "P-painotus", DWeighting: "D-painotus", DeadZone: "Kuollut alue" };
const label = (n: string) => { const [s, m] = n.split("."); return `${s === "Heat" ? "Lämmitys" : "Jäähdytys"} ${NAME_FI[m] ?? m}`; };

export async function waitJob(key: string, job: PidAiJob): Promise<PidAiJob> {
  for (let i = 0; i < 120 && job.status === "running"; i++) { await new Promise((r) => setTimeout(r, 2000)); job = await getPidAiJob(key, job.id); }
  return job;
}

/** Hook for the faceplate badge: true when the latest analysis has an unseen suggestion. */
export function usePidAiBadge(key: string | undefined) {
  const [n, setN] = useState(false);
  const clear = useCallback(() => setN(false), []);
  useEffect(() => {
    if (!key) return;
    let on = true;
    const f = () => getPidAi(key).then((s) => on && setN(s.hasNew)).catch(() => {});
    f(); const t = setInterval(f, 60_000);
    return () => { on = false; clearInterval(t); };
  }, [key]);
  return [n, clear] as const;
}

type Confirm = { kind: "apply" | "restore"; rows: [string, number | undefined, number, number | null][]; large: boolean } | null;

export function PidAiTab({ pidKey, onSeen }: { pidKey: string; onSeen?: () => void }) {
  const [s, setS] = useState<PidAiState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [okLarge, setOkLarge] = useState(false);
  const [lastRes, setLastRes] = useState<PidAiJob["result"] | null>(null);
  const load = useCallback(() => getPidAi(pidKey).then(setS).catch((e: Error) => toast.error(e.message)), [pidKey]);
  useEffect(() => { load(); markPidAiSeen(pidKey).then(() => onSeen?.()).catch(() => {}); }, [pidKey, load, onSeen]);

  const a = s?.analyses[sel];
  const r = a?.response;
  const prop = r?.proposed_params ?? {};
  const cur = a?.params ?? {};
  const rows = Object.entries(prop).map(([n, v]) => {
    const c = typeof cur[n] === "number" ? (cur[n] as number) : undefined;
    return [n, c, v, c ? ((v - c) / Math.abs(c)) * 100 : null] as [string, number | undefined, number, number | null];
  });
  const maxPct = (s?.maxRelChange ?? 0.5) * 100;
  const large = rows.some(([, c, v, p]) => p === null ? c !== v : Math.abs(p) > maxPct);
  const lastSnap = s?.history.find((h) => h.kind === "snapshot");

  async function run(what: string, start: () => Promise<PidAiJob>, okMsg: string) {
    setBusy(what);
    try {
      const j = await waitJob(pidKey, await start());
      if (j.status === "error") throw new Error(j.error);
      if (j.status === "running") throw new Error("aikakatkaisu, tarkista historia");
      if (j.result?.results) { setLastRes(j.result); if (j.result.ok) toast.success(okMsg); else toast.error("Osa parametreista ei päivittynyt, katso tulokset"); }
      else toast.success(okMsg);
      setSel(0); await load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const analyze = () => run("analyze", () => startPidAiAnalyze(pidKey), "Analyysi valmis");
  const doConfirm = () => {
    const c = confirm; setConfirm(null);
    if (!c || !a) return;
    if (c.kind === "apply") run("apply", () => startPidAiApply(pidKey, a.id, prop, okLarge), "Parametrit kirjoitettu ja luettu takaisin");
    else run("restore", () => startPidAiRestore(pidKey), "Edelliset parametrit palautettu");
  };

  return (
    <div className="space-y-3 text-sm" data-testid="pid-ai">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={Boolean(busy)} onClick={analyze} data-testid="pid-ai-analyze"
          className="min-h-11 rounded-md border border-zinc-300 bg-zinc-200 px-4 font-semibold text-zinc-900 disabled:opacity-50">
          {busy === "analyze" ? "Analysoidaan… (≈1 min)" : "Analysoi nyt"}
        </button>
        <span className="text-[11px] text-muted-foreground">DeepSeek, 24 h data + nykyiset parametrit. Enintään kerran {s?.rateMin ?? 10} min. Yöajo klo 3.00.</span>
      </div>

      {!a ? <div className="text-xs italic text-muted-foreground">Ei analyyseja vielä.</div> : (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="tabular-nums text-muted-foreground">{fmtT(a.at)} · {a.trigger === "nightly" ? "yöajo" : "käsin"} · {a.model}</span>
            {r?.risk && <span className={`rounded px-2 py-0.5 font-semibold ${RISK[r.risk] ?? "bg-muted"}`}>{RISK_FI[r.risk] ?? r.risk}</span>}
            {typeof r?.confidence === "number" && <span className="rounded bg-muted px-2 py-0.5">varmuus {Math.round(r.confidence * 100)} %</span>}
            {a.status === "applied" && <span className="rounded bg-emerald-900/60 px-2 py-0.5 text-emerald-200">otettu käyttöön</span>}
          </div>
          <div className="text-base">{r?.assessment}</div>
          {!!r?.issues?.length && <ul className="list-disc space-y-1 pl-5">{r.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {rows.length ? (
            <table className="w-full tabular-nums" data-testid="pid-ai-diff">
              <thead><tr className="text-left text-xs uppercase text-muted-foreground"><th className="py-1 font-normal">Parametri</th><th className="text-right font-normal">Nykyinen</th><th className="text-right font-normal">Ehdotettu</th><th className="text-right font-normal">Muutos %</th></tr></thead>
              <tbody>{rows.map(([n, c, v, p]) => (
                <tr key={n} className="border-b border-border/50">
                  <td className="py-1.5">{label(n)}</td><td className="text-right">{num(c)}</td><td className="text-right font-semibold">{num(v)}</td>
                  <td className={`text-right ${p !== null && Math.abs(p) > maxPct ? "text-amber-300" : ""}`}>{p === null ? (c === v ? "0" : "uusi") : `${p > 0 ? "+" : ""}${p.toFixed(0)}`}</td>
                </tr>))}
              </tbody>
            </table>
          ) : <div className="text-xs text-muted-foreground">Ei parametriehdotuksia: nykyiset arvot ovat riittävät.</div>}
          {r?.rationale && <div className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">Perustelu: </span>{r.rationale}</div>}
          <div className="rounded border border-amber-700/60 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-200">
            Ehdotus – ei kirjoiteta PLC:lle ilman vahvistusta. “Ota käyttöön” kirjoittaa arvot PLC:lle (CtrlParamsBackUp + LoadBackUp) vasta vahvistuksen jälkeen, tallentaa nykyiset arvot ensin ja lukee kirjoitetut takaisin.
          </div>
          <div className="flex flex-wrap gap-2">
            {rows.length > 0 && sel === 0 && a.status !== "applied" && (
              <button type="button" disabled={Boolean(busy)} data-testid="pid-ai-apply" onClick={() => { setOkLarge(false); setConfirm({ kind: "apply", rows, large }); }}
                className="min-h-11 rounded-md border border-emerald-500 px-4 font-semibold text-emerald-200 disabled:opacity-50">{busy === "apply" ? "Kirjoitetaan…" : "Ota käyttöön"}</button>
            )}
            {lastSnap && (
              <button type="button" disabled={Boolean(busy)} data-testid="pid-ai-restore"
                onClick={() => setConfirm({ kind: "restore", rows: Object.entries(lastSnap.params ?? {}).filter(([n]) => s?.limits[n.split(".")[1]]).map(([n, v]) => [n, typeof cur[n] === "number" ? (cur[n] as number) : undefined, v, null]), large: false })}
                className="min-h-11 rounded-md border border-border px-4 disabled:opacity-50">{busy === "restore" ? "Palautetaan…" : `Palauta edelliset (${fmtT(lastSnap.at)})`}</button>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            Vaikutus: PID_Temp ottaa uudet arvot käyttöön heti seuraavalla jaksolla LoadBackUp-käskyllä myös automaattitilassa. Siemensin mukaan muutos automaattitilassa voi aiheuttaa hypyn lähtöön. Kirjoitus estetään virityksen aikana (State 1/2) ja jos ErrorBits ≠ 0. Uusi viritys tai DB:n lataus TIA:sta korvaa arvot.
          </div>
        </div>
      )}

      {lastRes?.results && (
        <div className="rounded-md border border-border p-2 text-xs" data-testid="pid-ai-result">
          <div className="mb-1 font-semibold">Viimeisin kirjoitus</div>
          {Object.entries(lastRes.results).map(([n, x]) => <div key={n} className="tabular-nums">{x.ok ? "✓" : "✗"} {label(n)}: {num(x.before)} → {num(x.read)}</div>)}
        </div>
      )}

      {!!s?.analyses.length && (
        <div>
          <div className="mb-1 text-xs uppercase text-muted-foreground">Aiemmat analyysit</div>
          <ul className="space-y-1">{s.analyses.map((x, i) => (
            <li key={x.id}><button type="button" onClick={() => setSel(i)} className={`w-full rounded px-2 py-1 text-left text-xs ${i === sel ? "bg-muted" : "hover:bg-muted/60"}`}>
              <span className="tabular-nums text-muted-foreground">{fmtT(x.at)}</span> · {Object.keys(x.response?.proposed_params ?? {}).length} ehdotusta · {RISK_FI[x.response?.risk ?? ""] ?? "—"} · {x.status === "applied" ? "käytössä" : x.status === "new" ? "uusi" : x.trigger === "nightly" ? "yöajo" : "käsin"}
            </button></li>))}
          </ul>
        </div>
      )}
      {!!s?.history.length && (
        <div>
          <div className="mb-1 text-xs uppercase text-muted-foreground">Parametrimuutokset</div>
          <ul className="space-y-0.5 text-xs">{s.history.filter((h) => h.kind !== "snapshot").map((h) => (
            <li key={h.id} className="tabular-nums"><span className="text-muted-foreground">{fmtT(h.at)}</span> {h.kind === "restore" ? "palautus" : "käyttöönotto"} ({h.by_user}) · {Object.entries(h.result?.results ?? {}).map(([n, x]) => `${label(n)} ${num(x.before)}→${num(x.read)}${x.ok ? "" : " ✗"}`).join(", ")}</li>))}
          </ul>
        </div>
      )}

      <DialogPrimitive.Root open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/75" />
          <DialogPrimitive.Content data-testid="pid-ai-confirm" aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[61] w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-400 bg-background p-4 shadow-2xl">
            <DialogPrimitive.Title className="text-xs font-mono uppercase text-muted-foreground">Vahvista kirjoitus PLC:lle · {pidKey}</DialogPrimitive.Title>
            <div className="mt-2 text-base font-semibold">{confirm?.kind === "apply" ? "Ota AI-ehdotuksen parametrit käyttöön" : "Palauta parametrit tallennetusta tilannekuvasta"}</div>
            <table className="mt-2 w-full text-sm tabular-nums">
              <thead><tr className="text-left text-xs text-muted-foreground"><th className="font-normal">Parametri</th><th className="text-right font-normal">Nyt</th><th className="text-right font-normal">Uusi</th></tr></thead>
              <tbody>{confirm?.rows.map(([n, c, v]) => <tr key={n} className={c === v ? "text-muted-foreground" : ""}><td>{label(n)}</td><td className="text-right">{num(c)}</td><td className="text-right font-semibold">{num(v)}</td></tr>)}</tbody>
            </table>
            {confirm?.large && (
              <label className="mt-3 flex items-start gap-2 text-sm text-amber-200">
                <input type="checkbox" className="mt-1 h-4 w-4" checked={okLarge} onChange={(e) => setOkLarge(e.target.checked)} />
                Muutos on yli ±{maxPct.toFixed(0)} % ainakin yhdessä parametrissa. Hyväksyn suuren muutoksen.
              </label>
            )}
            <div className="mt-2 text-xs text-muted-foreground">Nykyiset arvot tallennetaan ensin. Kirjoitus CtrlParamsBackUp + LoadBackUp, sitten takaisinluku. Lähtö voi hypätä.</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className="min-h-11 rounded-md border border-border px-4 text-sm">Peruuta</button>
              <button type="button" disabled={confirm?.large && !okLarge} onClick={doConfirm} data-testid="pid-ai-confirm-ok"
                className="min-h-11 rounded-md border border-zinc-300 bg-zinc-200 px-5 text-sm font-semibold text-zinc-900 disabled:opacity-50">Kirjoita PLC:lle</button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
