import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { startPidParamsApply, startPidAiRestore, type PidAiJob } from "@/lib/apiClient";
import { waitJob } from "./PidAiTab";
import type { PidValues } from "@/lib/apiClient";

// Editable Retain.CtrlParams (Gain, Ti, Td, Cycle, DeadZone) -> same validated path as the AI apply:
// snapshot -> whitelist/limits/±50 % -> CtrlParamsBackUp + LoadBackUp -> read-back -> event.
const ROWS: { m: string; label: string; unit: string; h: keyof PidValues; c: keyof PidValues }[] = [
  { m: "Gain", label: "Vahvistus (Gain)", unit: "", h: "HGain", c: "CGain" },
  { m: "Ti", label: "Integrointiaika Ti", unit: "s", h: "HTi", c: "CTi" },
  { m: "Td", label: "Derivointiaika Td", unit: "s", h: "HTd", c: "CTd" },
  { m: "Cycle", label: "Säätöjakso (Cycle)", unit: "s", h: "HCyc", c: "CCyc" },
  { m: "DeadZone", label: "Kuollut alue (DeadZone)", unit: "", h: "HDZ", c: "CDZ" },
];
const COMPRESSOR = new Set(["F1", "T1"]);
const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const fmt = (x: number | undefined) => (x === undefined ? "—" : String(Number(x.toFixed(4))));

export function PidParamsEditor({ pidKey, v }: { pidKey: string; v: Partial<PidValues> | null }) {
  const cur = useMemo(() => {
    const o: Record<string, number | undefined> = {};
    for (const r of ROWS) { o[`Heat.${r.m}`] = n(v?.[r.h]); o[`Cool.${r.m}`] = n(v?.[r.c]); }
    return o;
  }, [v]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<[string, number | undefined, number, number | null][] | null>(null);
  const [okLarge, setOkLarge] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<PidAiJob["result"] | null>(null);
  useEffect(() => { if (!busy) setEdit({}); }, [pidKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <div className="text-xs italic text-muted-foreground">Ei PID-dataa.</div>;
  const running = v.State === 1 || v.State === 2;
  const errs = Number(v.ErrBits ?? 0) !== 0;

  const changes = Object.entries(edit).flatMap(([k, s]) => {
    const x = Number(String(s).replace(",", "."));
    if (s.trim() === "" || !Number.isFinite(x) || x === cur[k]) return [];
    const c = cur[k];
    return [[k, c, x, c ? ((x - c) / Math.abs(c)) * 100 : null] as [string, number | undefined, number, number | null]];
  });
  const large = (confirm ?? []).some(([, c, x, p]) => (p === null ? c !== x : Math.abs(p) > 50));
  const coolTouched = changes.some(([k]) => k.startsWith("Cool."));

  async function run(what: string, start: () => Promise<PidAiJob>) {
    setBusy(what); setConfirm(null);
    try {
      const j = await waitJob(pidKey, await start());
      if (j.status === "error") throw new Error(j.error);
      setRes(j.result ?? null);
      if (j.result?.ok) { toast.success("Parametrit kirjoitettu ja luettu takaisin"); setEdit({}); } else toast.error("Kirjoitus ei täysin onnistunut – katso tulokset");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-2 text-sm" data-testid="pid-params">
      <table className="w-full tabular-nums">
        <thead><tr className="text-left text-xs uppercase text-muted-foreground"><th className="py-1 font-normal">Parametri</th><th className="font-normal text-[#d9b08f]">Lämmitys</th><th className="font-normal text-[#a9c8e8]">Jäähdytys</th></tr></thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.m} className="border-b border-border/50">
              <td className="py-1 text-muted-foreground">{r.label}{r.unit ? ` (${r.unit})` : ""}</td>
              {(["Heat", "Cool"] as const).map((side) => {
                const k = `${side}.${r.m}`;
                return (
                  <td key={k} className="py-1 pr-2">
                    <input aria-label={`${side === "Heat" ? "Lämmitys" : "Jäähdytys"} ${r.m}`} data-testid={`pp-${k}`} inputMode="decimal" disabled={!!busy}
                      className={`w-24 rounded border bg-transparent px-1.5 py-0.5 ${edit[k] !== undefined && edit[k] !== fmt(cur[k]) ? "border-amber-400" : "border-border"}`}
                      value={edit[k] ?? fmt(cur[k])} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {COMPRESSOR.has(pidKey) && (
        <div className={`rounded border px-2 py-1 text-[11px] ${coolTouched ? "border-amber-500 text-amber-200" : "border-border text-muted-foreground"}`}>
          ⚠ Jäähdytys on kompressori: pieni Ti, suuri Gain tai kuollut alue 0 voi käynnistellä kompressoria tiheään (minimijaksot 30 s). Muuta jäähdytyksen parametreja varoen.
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="pp-save" disabled={!!busy || !changes.length || running || errs}
          className="rounded border border-sky-500 bg-sky-500/15 px-3 py-1 text-sky-100 disabled:opacity-40" onClick={() => { setOkLarge(false); setConfirm(changes); }}>
          {busy === "save" ? "Kirjoitetaan… (~1 min)" : `Tallenna${changes.length ? ` (${changes.length})` : ""}`}
        </button>
        <button type="button" disabled={!!busy || !changes.length} className="rounded border border-border px-3 py-1 disabled:opacity-40" onClick={() => setEdit({})}>Peru muutokset</button>
        <button type="button" data-testid="pp-restore" disabled={!!busy || running || errs} className="rounded border border-border px-3 py-1 disabled:opacity-40"
          onClick={() => { if (window.confirm("Palautetaanko viimeisin tallennettu tilannekuva (ennen edellistä kirjoitusta) PLC:lle?")) run("restore", () => startPidAiRestore(pidKey)); }}>
          {busy === "restore" ? "Palautetaan…" : "Palauta edelliset"}
        </button>
      </div>
      {(running || errs) && <div className="text-[11px] text-amber-300">Kirjoitus estetty: {running ? "viritys käynnissä (State 1/2)" : "ErrorBits ≠ 0"}.</div>}
      {res?.results && (
        <div className="text-[11px]" data-testid="pp-result">
          Viimeisin kirjoitus: {Object.entries(res.results).map(([k, r]) => <span key={k} className={r.ok ? "text-emerald-300" : "text-red-300"}>{k} {fmt(r.before)}→{fmt(r.read)} {r.ok ? "OK" : "VIRHE"} · </span>)}
        </div>
      )}
      <div className="text-[11px] text-muted-foreground">
        Kirjoitus: tilannekuva → tarkistus (sallitut jäsenet, rajat, ±50 %) → Retain.CtrlParamsBackUp + LoadBackUp → takaisinluku. PID_Temp ottaa arvot heti seuraavalla jaksolla; lähtö voi hypätä. ControlZone ei muokattavissa.
      </div>
      {confirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" role="dialog" aria-label="Vahvista parametrien kirjoitus" data-testid="pp-confirm">
          <div className="w-[min(92vw,460px)] space-y-3 rounded-lg border border-border bg-zinc-900 p-4 text-sm">
            <div className="font-semibold">Kirjoitetaanko {pidKey}:n parametrit PLC:lle?</div>
            <table className="w-full tabular-nums text-xs">
              <thead><tr className="text-left text-muted-foreground"><th>Parametri</th><th>Nykyinen</th><th>Uusi</th><th>Muutos</th></tr></thead>
              <tbody>{confirm.map(([k, c, x, p]) => (
                <tr key={k}><td>{k}</td><td>{fmt(c)}</td><td>{fmt(x)}</td><td className={p === null || Math.abs(p) > 50 ? "text-amber-300" : ""}>{p === null ? "uusi" : `${p > 0 ? "+" : ""}${p.toFixed(0)} %`}</td></tr>
              ))}</tbody>
            </table>
            {large && <label className="flex items-start gap-2 text-xs text-amber-200"><input type="checkbox" checked={okLarge} onChange={(e) => setOkLarge(e.target.checked)} data-testid="pp-large" />Hyväksyn yli ±50 % muutoksen (tai muutoksen nollasta).</label>}
            <div className="text-[11px] text-muted-foreground">Nykyiset arvot tallennetaan ensin (Palauta edelliset palauttaa ne).</div>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded border border-border px-3 py-1" onClick={() => setConfirm(null)}>Peruuta</button>
              <button type="button" data-testid="pp-confirm-ok" disabled={large && !okLarge} className="rounded border border-sky-500 bg-sky-500/20 px-3 py-1 disabled:opacity-40"
                onClick={() => { const p = Object.fromEntries(confirm.map(([k, , x]) => [k, x])); const lg = large; run("save", () => startPidParamsApply(pidKey, p, lg)); }}>Kirjoita PLC:lle</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
