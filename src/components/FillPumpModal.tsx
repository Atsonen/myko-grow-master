// Täyttöpumppu detail dialog – same informative style as EC & lannoiteannostelu.
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setFillPump, type FillPumpResponse } from "@/lib/apiClient";
import { DfBadge, DfKV, DfSection, DfSpBandTrend, DfSwitch, dfHm, dfYn } from "@/components/DeviceFaceplate";
import { DEFAULT_PUMP_META, PumpRunLegend, usePumpRuns } from "@/components/trends/PumpRunOverlay";
import { toast } from "sonner";

/** Faceplate level trend windows (same set as PID, without 7 d — hist is ~24 h). */
export const FILL_PUMP_TREND_RANGES = [
  { h: 0.5, label: "30 min" },
  { h: 1, label: "1 h" },
  { h: 3, label: "3 h" },
  { h: 12, label: "12 h" },
  { h: 24, label: "24 h" },
] as const;

const LS_TREND_H = "myko.fillPump.rangeHours";
export function loadFillPumpTrendHours(): number {
  try {
    const n = Number(localStorage.getItem(LS_TREND_H));
    if (FILL_PUMP_TREND_RANGES.some((r) => r.h === n)) return n;
  } catch { /* ignore */ }
  return 24;
}
export function saveFillPumpTrendHours(h: number) {
  try { localStorage.setItem(LS_TREND_H, String(h)); } catch { /* ignore */ }
}

/** Pumps shown on fill faceplate chart (fill + both circ). */
const FP_PUMP_IDS = new Set(["fill", "circ_l", "circ_r"]);

const FP_ERR: Record<number, string> = { 0: "ok", 1: "MaxRun ylitetty", 2: "käyntitieto / pinta-anturi" };

export function fillPumpStatus(p: FillPumpResponse["plc"] | undefined, live: boolean) {
  if (!live || !p) return { label: "–", kind: "muted" as const };
  if (p.St_Error) return { label: `Vika${typeof p.St_ErrCode === "number" && p.St_ErrCode ? ` E${p.St_ErrCode}` : ""}`, kind: "alarm" as const };
  if (p.St_Running || p.Pump || p.Run) return { label: "Käy", kind: "ok" as const };
  if (p.St_Waiting) return { label: "Odottaa", kind: "warning" as const };
  if (p.St_Skipped || (p.Done && p.Cfg_Enable === false)) return { label: "Ohitettu", kind: "muted" as const };
  if (p.Done) return { label: "Valmis", kind: "info" as const };
  return { label: "Seis", kind: "muted" as const };
}

export function FillPumpModal({
  open, d, reload, onClose,
}: {
  open: boolean;
  d: FillPumpResponse | null;
  reload: () => void;
  onClose: () => void;
}) {
  const live = !!d?.present;
  const p = d?.plc ?? {};
  const [sp, setSp] = useState("");
  const [hyst, setHyst] = useState("");
  const [maxRun, setMaxRun] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [rangeHours, setRangeHours] = useState(loadFillPumpTrendHours);
  const [pumpMaster, setPumpMaster] = useState(true);
  const [pumpVisible, setPumpVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DEFAULT_PUMP_META.filter((x) => FP_PUMP_IDS.has(x.id)).map((x) => [x.id, true])),
  );

  useEffect(() => {
    if (!open) return;
    if (typeof p.Cfg_LvlSP === "number") setSp(String(p.Cfg_LvlSP));
    if (typeof p.Cfg_Hyst === "number") setHyst(String(p.Cfg_Hyst));
    if (typeof p.Cfg_MaxRun_s === "number") setMaxRun(String(p.Cfg_MaxRun_s));
  }, [open, p.Cfg_LvlSP, p.Cfg_Hyst, p.Cfg_MaxRun_s]);

  const tEnd = useMemo(() => Date.now(), [d?.plc_at, d?.trend, rangeHours, open]);
  const tStart = tEnd - rangeHours * 3600_000;
  const fromIso = useMemo(() => new Date(tStart).toISOString(), [tStart]);
  const toIso = useMemo(() => new Date(tEnd).toISOString(), [tEnd]);
  const { pumps: pumpMetaAll, intervals: pumpIntervalsAll } = usePumpRuns(open && pumpMaster, fromIso, toIso);
  const pumpMeta = useMemo(
    () => (pumpMetaAll.length ? pumpMetaAll : DEFAULT_PUMP_META).filter((x) => FP_PUMP_IDS.has(x.id)),
    [pumpMetaAll],
  );
  const pumpIntervals = useMemo(
    () => pumpIntervalsAll.filter((iv) => FP_PUMP_IDS.has(iv.pump)),
    [pumpIntervalsAll],
  );
  const pumpCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const iv of pumpIntervals) c[iv.pump] = (c[iv.pump] ?? 0) + 1;
    return c;
  }, [pumpIntervals]);

  if (!open) return null;

  const level = typeof p.Level === "number" ? p.Level : typeof p.St_Level === "number" ? p.St_Level : null;
  const spN = typeof p.Cfg_LvlSP === "number" ? p.Cfg_LvlSP : null;
  const hystN = typeof p.Cfg_Hyst === "number" ? p.Cfg_Hyst : null;
  const st = fillPumpStatus(p, live);
  const errCode = typeof p.St_ErrCode === "number" ? p.St_ErrCode : undefined;
  const errText = errCode !== undefined ? (d?.err_codes?.[String(errCode)] ?? FP_ERR[errCode] ?? String(errCode)) : undefined;
  const canWrite = !!d?.write_allowed && live;
  const activeAlarms = Object.entries(d?.alarms?.active ?? {}).filter(([, v]) => v);
  const trend = (d?.trend ?? []) as [number, number][];
  const events = d?.events ?? [];
  const totRunS = typeof p.St_TotRun_ms === "number" ? p.St_TotRun_ms / 1000 : null;
  const runS = typeof p.St_RunTime_s === "number" ? p.St_RunTime_s : null;
  const dev = level != null && spN != null ? level - spN : null;

  const write = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      await setFillPump(body);
      toast.success(label);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveNum = (key: string, raw: string, min: number, max: number, intOnly: boolean, label: string) => {
    const n = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(n) || n < min || n > max || (intOnly && !Number.isInteger(n))) {
      toast.error(`${label} ${min}–${max}`);
      return;
    }
    if (!window.confirm(`Vahvista: FillPump ${key} → ${n}?`)) return;
    void write({ [key]: n }, `${label} ${n}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,1100px)] max-w-none overflow-y-auto border-zinc-700 bg-zinc-950 p-0 font-mono" data-testid="fp-modal">
        <DialogHeader className="sticky top-0 z-10 border-b border-border bg-zinc-950/95 px-5 py-3 backdrop-blur">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            Täyttöpumppu
            <DfBadge kind={st.kind === "ok" ? "ok" : st.kind === "alarm" ? "alarm" : st.kind === "warning" ? "warning" : st.kind === "info" ? "info" : "muted"}>{st.label}</DfBadge>
            {errCode !== undefined && errCode !== 0 && <DfBadge kind="alarm">E{errCode} · {errText}</DfBadge>}
            {activeAlarms.map(([k]) => <DfBadge key={k} kind="alarm">{k}</DfBadge>)}
            {!live && <DfBadge kind="warning">Ei dataa</DfBadge>}
            {p.St_Error === true && canWrite && (
              <button type="button" data-testid="fp-modal-ack" disabled={!!busy}
                className="ml-auto mr-8 rounded-md border border-red-500 bg-red-600/20 px-3 py-1 text-xs font-bold text-red-100 hover:bg-red-600/40"
                onClick={() => {
                  if (!window.confirm("Vahvista: FillPump Cmd_Ack → TRUE (kuittaus)?")) return;
                  void write({ Cmd_Ack: true }, "Kuitattu");
                }}>Kuittaa</button>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 p-4 lg:grid-cols-3">
          <section className="rounded-lg border border-border bg-gradient-to-br from-zinc-900 to-zinc-950 p-4 lg:col-span-1">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Pinta nyt</div>
            <div className="text-5xl font-bold tabular-nums text-sky-300" data-testid="fp-level">
              {level != null ? level.toFixed(1) : "—"}
              <span className="ml-1 text-lg text-muted-foreground">%</span>
            </div>
            <div className="mt-1 text-sm">
              SP <b className="tabular-nums">{spN ?? "—"}</b>
              {hystN != null && <> · hyst <b className="tabular-nums">{hystN}</b></>}
              {dev != null && <> · poikkeama <b className="tabular-nums">{dev > 0 ? "+" : ""}{dev.toFixed(1)}</b></>}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">PLC {dfHm(d?.plc_at)}</div>
            <div className="mt-3 space-y-0.5 text-xs">
              <DfKV k="Status" v={st.label} cls={st.kind === "alarm" ? "text-red-300" : st.kind === "ok" ? "text-emerald-300" : ""} />
              <DfKV k="Pump" v={dfYn(p.Pump)} cls={p.Pump ? "text-emerald-400" : ""} />
              <DfKV k="Done" v={dfYn(p.Done)} />
              <DfKV k="HB" v={dfYn(p.HbOk ?? p.St_HbOk)} cls={(p.HbOk ?? p.St_HbOk) === false ? "text-amber-300" : "text-emerald-400"} />
              <DfKV k="Käynti (nyt)" v={runS != null ? `${runS} s` : "—"} />
              <DfKV k="Käynnistyksiä" v={p.St_Starts ?? "—"} />
              <DfKV k="Kokonaiskäynti" v={totRunS != null ? `${(totRunS / 60).toFixed(1)} min` : "—"} />
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card/60 p-3 lg:col-span-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Pintatrendi ({FILL_PUMP_TREND_RANGES.find((r) => r.h === rangeHours)?.label ?? `${rangeHours} h`})
              </div>
              <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Trendin aikaikkuna">
                {FILL_PUMP_TREND_RANGES.map((r) => (
                  <button
                    key={r.h}
                    type="button"
                    role="radio"
                    aria-checked={rangeHours === r.h}
                    data-testid={`fp-trend-range-${r.h}`}
                    onClick={() => { setRangeHours(r.h); saveFillPumpTrendHours(r.h); }}
                    className={`h-7 rounded border px-2 text-[11px] font-mono ${
                      rangeHours === r.h
                        ? "border-zinc-300 bg-zinc-200 text-zinc-900"
                        : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/70"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <DfSpBandTrend
              pts={trend.filter((pt) => pt[0] >= tStart - 60_000 && pt[0] <= tEnd + 60_000)}
              sp={spN}
              hyst={hystN}
              min={p.Cfg_LvlMin}
              max={p.Cfg_LvlMax}
              unit="%"
              testid="fp-trend"
              tStart={tStart}
              tEnd={tEnd}
              pumpIntervals={pumpMaster ? pumpIntervals : []}
              pumpMeta={pumpMeta}
              pumpVisible={pumpVisible}
            />
            <div className="mt-2">
              <PumpRunLegend
                pumps={pumpMeta}
                visible={pumpVisible}
                onToggle={(id) => setPumpVisible((v) => ({ ...v, [id]: v[id] === false }))}
                counts={pumpCounts}
                master={pumpMaster}
                onMaster={setPumpMaster}
              />
            </div>
          </section>

          <DfSection title="Asetukset (Cfg_*)">
            <div className="space-y-2 text-xs">
              <label className="block">
                <span className="text-muted-foreground">SP (Cfg_LvlSP) %</span>
                <div className="mt-1 flex gap-2">
                  <input data-testid="fp-modal-sp" type="number" min={0} max={100} step={0.1} value={sp}
                    onChange={(e) => setSp(e.target.value)} disabled={!canWrite || !!busy}
                    className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono" />
                  <button type="button" disabled={!canWrite || !!busy}
                    className="rounded-md bg-sky-600 px-3 text-xs font-semibold text-white disabled:opacity-40"
                    onClick={() => saveNum("Cfg_LvlSP", sp, 0, 100, false, "SP")}>Tallenna</button>
                </div>
              </label>
              <label className="block">
                <span className="text-muted-foreground">Hystereesi (Cfg_Hyst)</span>
                <div className="mt-1 flex gap-2">
                  <input data-testid="fp-modal-hyst" type="number" min={0} max={20} step={0.1} value={hyst}
                    onChange={(e) => setHyst(e.target.value)} disabled={!canWrite || !!busy}
                    className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono" />
                  <button type="button" disabled={!canWrite || !!busy}
                    className="rounded-md bg-sky-600 px-3 text-xs font-semibold text-white disabled:opacity-40"
                    onClick={() => saveNum("Cfg_Hyst", hyst, 0, 20, false, "Hyst")}>Tallenna</button>
                </div>
              </label>
              <label className="block">
                <span className="text-muted-foreground">MaxRun (Cfg_MaxRun_s)</span>
                <div className="mt-1 flex gap-2">
                  <input data-testid="fp-modal-max" type="number" min={10} max={3600} step={1} value={maxRun}
                    onChange={(e) => setMaxRun(e.target.value)} disabled={!canWrite || !!busy}
                    className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono" />
                  <button type="button" disabled={!canWrite || !!busy}
                    className="rounded-md bg-sky-600 px-3 text-xs font-semibold text-white disabled:opacity-40"
                    onClick={() => saveNum("Cfg_MaxRun_s", maxRun, 10, 3600, true, "MaxRun")}>Tallenna</button>
                </div>
              </label>
              <DfSwitch
                testid="fp-modal-enable"
                on={!!p.Cfg_Enable}
                label="Enable (Cfg_Enable)"
                disabled={!canWrite || p.Cfg_Enable === undefined || !!busy}
                title="Kirjoittaa Cfg_Enable PLC:hen (vahvistus)"
                onClick={() => {
                  const en = !p.Cfg_Enable;
                  if (!window.confirm(`Vahvista: FillPump Cfg_Enable → ${en ? "TRUE (käyttöön)" : "FALSE (pois)"}?`)) return;
                  void write({ Cfg_Enable: en }, `Enable ${en ? "ON" : "OFF"}`);
                }}
              />
              <div className="text-[11px] text-muted-foreground">{d?.write_note}</div>
            </div>
          </DfSection>

          <DfSection
            title="PLC Pumput.FillPump"
            right={!d?.present ? <DfBadge kind="alarm">DB puuttuu</DfBadge> : !d.stale ? <DfBadge kind="ok">Yhteys</DfBadge> : <DfBadge kind="warning">Vanha data</DfBadge>}
          >
            <div className="space-y-0.5 text-xs">
              <DfKV k="St_Status" v={p.St_Status ?? "—"} />
              <DfKV k="St_Running" v={dfYn(p.St_Running)} cls={p.St_Running ? "text-emerald-400" : ""} />
              <DfKV k="St_Waiting" v={dfYn(p.St_Waiting)} cls={p.St_Waiting ? "text-amber-300" : ""} />
              <DfKV k="St_Skipped" v={dfYn(p.St_Skipped)} />
              <DfKV k="St_Error" v={dfYn(p.St_Error)} cls={p.St_Error ? "text-red-400" : ""} />
              <DfKV k="St_ErrCode" v={errCode ?? "—"} cls={errCode && errCode !== 0 ? "text-red-300" : ""} />
              <DfKV k="Cfg_Enable" v={dfYn(p.Cfg_Enable)} />
              <DfKV k="Cfg_LvlSP" v={spN ?? "—"} />
              <DfKV k="Cfg_Hyst" v={hystN ?? "—"} />
              <DfKV k="Cfg_MaxRun_s" v={p.Cfg_MaxRun_s ?? "—"} />
              <DfKV k="Cfg_LvlMin/Max" v={`${p.Cfg_LvlMin ?? "—"} / ${p.Cfg_LvlMax ?? "—"}`} />
              <DfKV k="Cmd_Ack" v={dfYn(p.Cmd_Ack)} />
              <DfKV k="Level / St_Level" v={`${typeof p.Level === "number" ? p.Level.toFixed(2) : "—"} / ${typeof p.St_Level === "number" ? p.St_Level.toFixed(2) : "—"}`} />
              <DfKV k="St_RunTime_s" v={runS ?? "—"} />
              <DfKV k="St_TotRun_ms" v={p.St_TotRun_ms ?? "—"} />
              <DfKV k="St_Starts" v={p.St_Starts ?? "—"} />
            </div>
          </DfSection>

          <DfSection title={`Hälytykset / tapahtumat (${events.length})`}>
            <div className="max-h-72 overflow-auto rounded border border-border/60">
              <table className="w-full text-xs" data-testid="fp-events">
                <thead className="sticky top-0 bg-zinc-900 text-left text-[11px] uppercase text-muted-foreground">
                  <tr><th className="px-2 py-1">Aika</th><th className="px-2 py-1">Tyyppi</th><th className="px-2 py-1">Kuvaus</th></tr>
                </thead>
                <tbody>
                  {events.length === 0 && (
                    <tr><td colSpan={3} className="px-2 py-3 text-center text-muted-foreground">ei tapahtumia vielä (hälytykset + UI-kirjoitukset)</td></tr>
                  )}
                  {events.map((e, i) => (
                    <tr key={`${e.ts}-${i}`} className={`border-t border-border/40 ${e.kind === "alarm" ? "bg-red-950/40" : ""}`}>
                      <td className="whitespace-nowrap px-2 py-1 tabular-nums">{dfHm(e.ts)}</td>
                      <td className="px-2 py-1">
                        {e.kind === "alarm" ? <DfBadge kind="alarm">Hälytys</DfBadge>
                          : e.kind === "ack" ? <DfBadge kind="ok">Ack</DfBadge>
                          : e.kind === "cmd" ? <DfBadge kind="info">Cmd</DfBadge>
                          : <DfBadge kind="muted">{e.kind}</DfBadge>}
                      </td>
                      <td className="px-2 py-1">{e.text}{e.code ? <span className="ml-1 text-muted-foreground">({e.code})</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {activeAlarms.length > 0 && (
              <div className="mt-2 space-y-1 text-xs text-red-300">
                {activeAlarms.map(([k]) => (
                  <div key={k}>● {d?.alarms?.texts?.[k] ?? k}</div>
                ))}
              </div>
            )}
          </DfSection>
        </div>
      </DialogContent>
    </Dialog>
  );
}
