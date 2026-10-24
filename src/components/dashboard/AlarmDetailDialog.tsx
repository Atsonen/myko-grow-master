import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { getAlarmDetail, type AlarmDetail } from "@/lib/apiClient";

/** Alarm list row details (click a row in AlarmListWidget). Times in Europe/Helsinki. */
const HEL: Intl.DateTimeFormatOptions = { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" };
const t = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("fi-FI", HEL) : "—");
const tShort = (iso: string) => new Date(iso).toLocaleTimeString("fi-FI", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const num = (v: number | null | undefined, u = "") => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(2)}${u ? ` ${u}` : ""}`);
function dur(sec?: number) {
  if (sec === undefined) return "—";
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d} d ${h % 24} h`;
  if (h) return `${h} h ${m % 60} min`;
  return `${m} min ${sec % 60} s`;
}
const EV: Record<string, string> = { start: "alkoi", clear: "poistui", ack: "kuitattu", control: "ohjaus", llm: "DeepSeek" };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (<><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></>);
}

export function AlarmDetailDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [d, setD] = useState<AlarmDetail | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (id === null) return;
    setD(null); setErr("");
    let c = false;
    getAlarmDetail(id).then((x) => !c && setD(x)).catch((e) => !c && setErr((e as Error).message));
    return () => { c = true; };
  }, [id]);
  return (
    <DialogPrimitive.Root open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/75" />
        <DialogPrimitive.Content data-testid="al-detail" aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] max-h-[90vh] w-[min(94vw,640px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-zinc-500 bg-background p-4 text-sm shadow-2xl">
          <div className="flex items-start gap-2">
            <DialogPrimitive.Title className="flex-1 text-base font-semibold">
              {d ? <><span className="font-mono">{d.alarm}</span> · {d.pointName}</> : "Hälytyksen tiedot"}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="min-h-11 min-w-11 rounded-md border border-border px-3" aria-label="Sulje">✕</DialogPrimitive.Close>
          </div>
          {err && <div className="mt-2 text-destructive">{err}</div>}
          {!d && !err && <div className="mt-2 italic text-muted-foreground">Ladataan…</div>}
          {d && d.kind === "llm" && (
            <div className="mt-2 space-y-2">
              <div><div className="text-xs uppercase text-muted-foreground">Havainto</div><div>{d.finding}</div></div>
              <div><div className="text-xs uppercase text-muted-foreground">Ehdotus</div><div>{d.suggestion || "—"}</div></div>
              <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1">
                <Row k="Aika" v={t(d.start)} />
                <Row k="Vakavuus" v={d.severity} />
                <Row k="Kohde / luokka" v={`${d.point} · ${d.category}`} />
                <Row k="Lähde" v={`DeepSeek-valvoja (${d.trigger ?? "?"})`} />
                <Row k="Anturireset-suositus" v={d.recommendReset ? "kyllä" : "ei"} />
                <Row k="WhatsApp" v={d.whatsapp === null ? "—" : d.whatsapp ? "lähetetty" : "ei"} />
              </dl>
            </div>
          )}
          {d && d.kind === "alarm" && (
            <div className="mt-2 space-y-3">
              <div>
                <div className="font-semibold">{d.desc}</div>
                {d.rule && d.rule !== d.desc && <div className="text-muted-foreground">Sääntö: {d.rule}</div>}
              </div>
              <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1">
                <Row k="Tila" v={d.active ? <span className="font-semibold text-amber-300">Aktiivinen</span> : "Poistunut"} />
                <Row k="Alkoi" v={t(d.start)} />
                <Row k="Poistui" v={t(d.end)} />
                <Row k="Kesto" v={dur(d.durationSec)} />
                <Row k="Arvo alussa" v={num(d.value, d.unit)} />
                <Row k="Arvo lopussa" v={num(d.endValue, d.unit)} />
                <Row k="Raja" v={d.threshold ?? d.rule ?? "—"} />
                {d.pid && <Row k={`PID ${d.pid.key} nyt`} v={`SP ${num(d.pid.sp)} · PV ${num(d.pid.pv)} · Heat ${num(d.pid.outHeat, "%")} · Cool ${num(d.pid.outCool, "%")} · State ${d.pid.state ?? "—"}`} />}
                <Row k="Lähde" v={d.source === "PLC" ? "PLC (PID_Temp, OPC UA)" : "Myko (anturi/raja)"} />
                <Row k="Prioriteetti" v={d.priority === 1 ? "1 – hälytys" : "2 – varoitus"} />
                <Row k="Kuittaus" v={d.acked ? `${t(d.ackedAt)} · ${d.ackedBy ?? "?"}` : "kuittaamaton"} />
                <Row k="Piste / bitti" v={`${d.pointId} · bit ${d.bit ?? "—"}${d.statusWord !== null && d.statusWord !== undefined ? ` · tilasana ${d.statusWord}` : ""}`} />
              </dl>
              <div>
                <div className="text-xs uppercase text-muted-foreground">Liittyvät tapahtumat (±10 min)</div>
                {d.related.length === 0 ? <div className="text-muted-foreground">Ei muita tapahtumia.</div> : (
                  <ul className="mt-1 space-y-0.5" data-testid="al-detail-related">
                    {d.related.map((r) => (
                      <li key={r.id} className={r.id === d.id ? "font-semibold" : ""}>
                        <span className="tabular-nums text-muted-foreground">{tShort(r.at)}</span> <span className="font-mono">{r.event === "llm" ? "LLM" : r.alarm}</span> {EV[r.event] ?? r.event}
                        {r.pointId !== d.pointId ? ` · ${r.pointName}` : ""}{r.value !== null ? ` · ${num(r.value)}` : ""}
                        {r.event !== "llm" && <span className="text-muted-foreground"> – {r.desc}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {d.relatedLlm.length > 0 && (
                <div>
                  <div className="text-xs uppercase text-muted-foreground">DeepSeek-valvojan havainnot (±10 min)</div>
                  <ul className="mt-1 space-y-1">{d.relatedLlm.map((f) => (
                    <li key={f.id}><span className="tabular-nums text-muted-foreground">{tShort(f.at)}</span> [{f.severity}] {f.finding}{f.suggestion ? <div className="text-muted-foreground">→ {f.suggestion}</div> : null}</li>
                  ))}</ul>
                </div>
              )}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
