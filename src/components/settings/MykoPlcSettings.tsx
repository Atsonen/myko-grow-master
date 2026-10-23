import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Pt = { struct: string; safeOutput: number; freezeS: number };
type St = {
  flag: boolean; settings: { common: Record<string, number>; points: Record<string, Pt> }; limits: Record<string, [number, number]>;
  detect: { found: boolean | null; at: string | null; fields: string[]; error: string | null; iface?: string | null };
  writer: { running: boolean; hb: number; lastHbAt: string | null; lastError: string | null; lastSettingsWrite: { at: string } | null };
  resets: { id: number; at: string; by_user: string; source: string; result: string; detail: string }[]; resetRule: { lockoutS: number; perDay: number };
};
type Finding = { id: number; at: string; severity: string; point: string; category: string; finding: string; suggestion: string; recommend_reset: boolean; duplicate: boolean; whatsapp: number | null };
type An = { everyMin: number; ignore: string[]; last: { at: string; findings: number; frozen: string[]; stale: string[]; tokens: { prompt_tokens?: number; completion_tokens?: number } } | null; findings: Finding[] };

const j = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, init); const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`); return b as T;
};
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const t = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const inp = "h-7 w-20 rounded border border-input bg-background px-2 text-xs font-mono";
const SEVC: Record<string, string> = { high: "bg-red-900/70 text-red-200", medium: "bg-amber-900/60 text-amber-200", low: "bg-sky-900/50 text-sky-200", info: "bg-zinc-800 text-zinc-300" };
const NAMES: Record<string, string> = { F1: "F1 Kylmäsäilytystila 1", T1: "T1 Terrario 1", G_Air: "G_Air Kasvamo ilma" };

export function MykoPlcSettings() {
  const [s, setS] = useState<St | null>(null);
  const [an, setAn] = useState<An | null>(null);
  const [ed, setEd] = useState<{ common: Record<string, string>; points: Record<string, Record<string, string>> }>({ common: {}, points: {} });
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { j<St>("/api/myko/settings").then(setS).catch((e) => toast.error(e.message)); j<An>("/api/myko/anomaly").then(setAn).catch(() => {}); }, []);
  useEffect(() => { load(); const i = setInterval(load, 30_000); return () => clearInterval(i); }, [load]);
  if (!s) return null;
  const writable = s.flag && s.detect.found;
  const val = (p: string | null, k: string) => (p ? ed.points[p]?.[k] ?? String(s.settings.points[p][k as keyof Pt]) : ed.common[k] ?? String(s.settings.common[k]));
  const set = (p: string | null, k: string, v: string) => setEd((o) => (p ? { ...o, points: { ...o.points, [p]: { ...o.points[p], [k]: v } } } : { ...o, common: { ...o.common, [k]: v } }));
  const dirty = Object.keys(ed.common).length + Object.values(ed.points).reduce((n, o) => n + Object.keys(o).length, 0) > 0;
  const lim = (k: string) => s.limits[k] ? `${s.limits[k][0]}–${s.limits[k][1]}` : "";
  async function act(name: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(name); try { await fn(); toast.success(ok); load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const save = () => act("save", async () => {
    const num = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v.replace(",", "."))]));
    await j("/api/myko/settings", send("PUT", { common: num(ed.common), points: Object.fromEntries(Object.entries(ed.points).map(([p, o]) => [p, num(o)])) }));
    setEd({ common: {}, points: {} });
  }, writable ? "Tallennettu ja kirjoitettu DB_Mykoon" : "Tallennettu (ei kirjoitettu PLC:lle – DB_Myko ei käytössä)");

  return (
    <Card className="space-y-4 p-4 text-xs" data-testid="myko-plc-settings">
      <div>
        <h2 className="font-mono text-sm">Myko → PLC (DB_Myko)</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 ${s.flag ? "bg-emerald-900/60 text-emerald-200" : "bg-zinc-800 text-zinc-300"}`}>Lippu MYKO_DB_ENABLED: {s.flag ? "päällä" : "pois"}</span>
          <span className={`rounded px-2 py-0.5 ${s.detect.found ? "bg-emerald-900/60 text-emerald-200" : "bg-amber-900/60 text-amber-200"}`}>
            DB_Myko PLC:ssä: {s.detect.found === null ? "ei tarkistettu" : s.detect.found ? `löytyi (${s.detect.fields.length} kenttää)` : "ei löydy"} · {t(s.detect.at)}
          </span>
          <span className="rounded bg-zinc-800 px-2 py-0.5">Heartbeat (Common.Hb_Counter, 1 s): {s.writer.running ? `${s.writer.hb} · ${t(s.writer.lastHbAt)}` : "ei käynnissä"}</span>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("detect", () => j("/api/myko/detect", send("POST")), "Tunnistus ajettu")}>{busy === "detect" ? "Tunnistetaan…" : "Tunnista DB_Myko"}</Button>
        </div>
        <p className="mt-1 text-muted-foreground">
          {writable ? "Asetukset kirjoitetaan DB_Mykoon tallennettaessa ja minuutin välein." : "DB_Mykoa ei vielä ole PLC:ssä (tai lippu on pois): arvot tallennetaan Mykoon ja kirjoitetaan automaattisesti, kun DB löytyy ja lippu on päällä. PLC rajaa arvot omilla rajoillaan."}
          {s.writer.lastError ? <span className="text-amber-300"> Virhe: {s.writer.lastError}</span> : null}
        </p>
      </div>
      <table className="w-full max-w-3xl">
        <thead className="text-left text-[10px] uppercase text-muted-foreground"><tr><th className="py-1">Piste</th><th>DB_Myko-struct</th><th>Turvatilan lähtö Safe_Output % ({lim("safeOutput")})</th><th>PV:n jäätymisraja PV_FreezeS s ({lim("freezeS")})</th></tr></thead>
        <tbody>{Object.entries(s.settings.points).map(([p, o]) => (
          <tr key={p} className="border-b border-border/50"><td className="py-1">{NAMES[p] ?? p}</td><td className="font-mono">{o.struct}</td>
            <td><input aria-label={`${p} Safe_Output`} className={inp} value={val(p, "safeOutput")} onChange={(e) => set(p, "safeOutput", e.target.value)} /></td>
            <td><input aria-label={`${p} PV_FreezeS`} className={inp} value={val(p, "freezeS")} onChange={(e) => set(p, "freezeS", e.target.value)} /></td></tr>
        ))}</tbody>
      </table>
      <div className="flex flex-wrap items-end gap-4">
        {[["wdTimeoutS", "Watchdog-aikaraja Wd_TimeoutS s"], ["pwrOffS", "Anturireset: katkoaika s"], ["pwrLockoutS", "Anturireset: lukitus s"]].map(([k, l]) => (
          <label key={k} className="flex flex-col gap-1"><span className="text-muted-foreground">{l} ({lim(k)})</span><input aria-label={k} className={inp} value={val(null, k)} onChange={(e) => set(null, k, e.target.value)} /></label>
        ))}
        <Button size="sm" disabled={!dirty || !!busy} onClick={save} data-testid="myko-settings-save">Tallenna</Button>
        {dirty && <Button size="sm" variant="ghost" onClick={() => setEd({ common: {}, points: {} })}>Peru</Button>}
      </div>

      <div className="space-y-1 border-t border-border pt-3">
        <h3 className="font-mono text-sm">Anturien 5 V reset (SensorBlock 1 + 2)</h3>
        <p className="text-muted-foreground">Common.Cmd_SensorPwrReset-pulssi: PLC katkaisee 5 V:n syötön n. {s.settings.common.pwrOffS} s. Lukitus {s.resetRule.lockoutS / 60} min ja enintään {s.resetRule.perDay} / 24 h (Myko ja PLC). Kaikki pyynnöt kirjataan.</p>
        <Button size="sm" variant="outline" disabled={!!busy || !writable} data-testid="sensor-reset"
          onClick={() => { if (window.confirm("Katkaistaanko anturien 5 V syöttö hetkeksi (SensorBlock 1 ja 2)? Anturien arvot puuttuvat reboot-ajan.")) act("reset", () => j("/api/myko/sensor-reset", send("POST", { reason: "käsin asetuksista" })), "Reset lähetetty"); }}>
          {writable ? "Resetoi anturit…" : "Resetoi anturit (vaatii DB_Myko)"}
        </Button>
        {s.resets.length > 0 && <ul className="text-muted-foreground">{s.resets.map((r) => <li key={r.id}>{t(r.at)} · {r.result} · {r.by_user} · {r.detail}</li>)}</ul>}
      </div>

      <div className="space-y-2 border-t border-border pt-3" data-testid="anomaly-panel">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-sm">DeepSeek-valvoja (vain luku, {an?.everyMin ?? 15} min välein)</h3>
          <span className="text-muted-foreground">Viimeisin: {t(an?.last?.at)} · löydöksiä {an?.last?.findings ?? "—"}{an?.last?.frozen?.length ? ` · jäätyneet: ${an.last.frozen.join(", ")}` : ""}</span>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("an", () => j("/api/myko/anomaly/run", send("POST")), "Analyysi valmis")}>{busy === "an" ? "Analysoidaan…" : "Aja nyt"}</Button>
        </div>
        <p className="text-muted-foreground">High-taso (vain PID:t ja niiden PV-anturit F1 dl02, T1 dl00, G_Air dl31) → WhatsApp normaalia reittiä; sama löydös toistetaan aikaisintaan 6 h päästä. Valvoja voi suositella anturiresetiä, mutta ei tee sitä. Ohitettavat anturit (pilkuin):
          <input aria-label="Ohitettavat" className="ml-2 h-7 w-56 rounded border border-input bg-background px-2 font-mono" defaultValue={an?.ignore.join(",") ?? ""} key={an?.ignore.join(",")}
            onBlur={(e) => j("/api/myko/anomaly/ignore", send("PUT", { keys: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })).then(load).catch((er) => toast.error(er.message))} />
        </p>
        <ul className="space-y-1">{(an?.findings ?? []).filter((f) => !f.duplicate).slice(0, 15).map((f) => (
          <li key={f.id} className="flex gap-2"><span className={`h-fit shrink-0 rounded px-1.5 ${SEVC[f.severity] ?? ""}`}>{f.severity}</span>
            <span><span className="text-muted-foreground">{t(f.at)} · {f.point} · {f.category}</span> — {f.finding} <span className="text-muted-foreground">→ {f.suggestion}</span>{f.recommend_reset ? <span className="text-amber-300"> (suositus: anturireset)</span> : null}{f.whatsapp ? " · WhatsApp" : ""}</span></li>
        ))}</ul>
      </div>
    </Card>
  );
}
