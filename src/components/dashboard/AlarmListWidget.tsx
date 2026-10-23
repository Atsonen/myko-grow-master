import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { ackAlarms, getAlarmSummary, plcErrorAckAll, type AlarmSummary, type AlarmSummaryRow } from "@/lib/apiClient";
import { useDashboardData } from "./DashboardData";
import { AlarmIndicator } from "./MeasurementPointWidget";
import type { WidgetConfigMap } from "./types";

/** "Hälytyslista": SCADA-style alarm summary across all points (ISA-101: neutral, colour only for active alarms). */
const HEL: Intl.DateTimeFormatOptions = { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" };
const fmtTime = (iso: string) => new Date(iso).toLocaleString("fi-FI", HEL);
export function fmtDuration(sec: number) {
  if (sec < 60) return "<1 min";
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d} d ${h % 24} h`;
  if (h > 0) return `${h} h ${m % 60} min`;
  return `${m} min`;
}
const RANGES: [number, string][] = [[1, "1 h"], [8, "8 h"], [24, "24 h"], [168, "7 d"], [720, "30 d"], [2160, "90 d"]];
type SortKey = "start" | "point" | "alarm" | "priority" | "state" | "value" | "duration";
const COLS: [SortKey, string, string][] = [
  ["start", "Aika", "w-[8.5rem]"],
  ["point", "Mittauspiste", ""],
  ["alarm", "Hälytys", ""],
  ["priority", "Prio", "w-14"],
  ["state", "Tila", "w-24"],
  ["value", "Arvo", "w-20 text-right"],
  ["duration", "Kesto", "w-24 text-right"],
];
const sortVal = (r: AlarmSummaryRow, k: SortKey): string | number => {
  switch (k) {
    case "start": return r.start;
    case "point": return r.pointName.toLowerCase();
    case "alarm": return r.alarm;
    case "priority": return r.priority;
    case "state": return r.active ? 0 : 1;
    case "value": return r.value ?? -Infinity;
    case "duration": return r.durationSec;
  }
};
const SEL = "h-11 rounded-md border border-input bg-background px-2 text-sm";

function Prio({ r, size = "h-5 w-5" }: { r: AlarmSummaryRow; size?: string }) {
  const lvl = r.priority === 1 ? "alarm" : "warn";
  return (
    <span className={`inline-flex ${r.active ? "" : "opacity-40 grayscale"}`} title={`Prioriteetti ${r.priority}`}>
      <AlarmIndicator level={lvl} className={size} />
    </span>
  );
}
function SrcBadge({ r }: { r: AlarmSummaryRow }) {
  return r.source === "PLC"
    ? <span className="rounded bg-sky-700 px-1.5 py-px text-[11px] font-bold text-white" title="PLC (PID_Temp OPC UA)">PLC</span>
    : <span className="rounded border border-zinc-500 px-1.5 py-px text-[11px] text-zinc-300" title="Myko (anturi/raja)">MYKO</span>;
}
const hex = (n: number | undefined) => (n === undefined || n === null ? "—" : `16#${(n >>> 0).toString(16).toUpperCase().padStart(4, "0")}`);
const activeText = (r: AlarmSummaryRow) => (r.active ? (r.priority === 1 ? "text-red-400 font-semibold" : "text-amber-300 font-semibold") : "text-muted-foreground");

export function AlarmListWidget({ config }: { config: WidgetConfigMap["alarmList"] }) {
  const { tick } = useDashboardData();
  const [hours, setHours] = useState(config.hours ?? 24);
  const [points, setPoints] = useState<string[]>(config.pointId ? [config.pointId] : []); // empty = all
  const [types, setTypes] = useState<string[]>([]); // empty = all
  const [prio, setPrio] = useState<string>(config.priority ? String(config.priority) : "");
  const [activeOnly, setActiveOnly] = useState(Boolean(config.activeOnly));
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "state", dir: 1 }); // active first, then newest
  const [data, setData] = useState<AlarmSummary | null>(null);
  const [err, setErr] = useState("");
  const [ackOpen, setAckOpen] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [source, setSource] = useState<"" | "PLC" | "Myko">("");
  const [plcOpen, setPlcOpen] = useState(false);
  const limit = config.limit ?? 200;

  useEffect(() => { setHours(config.hours ?? 24); }, [config.hours]);
  useEffect(() => {
    let cancelled = false;
    getAlarmSummary(hours, limit)
      .then((d) => { if (!cancelled) { setData(d); setErr(""); } })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => { cancelled = true; };
  }, [hours, limit, tick, reload]);

  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter(
      (r) => (!points.length || points.includes(r.pointId)) && (!types.length || types.includes(r.alarm)) && (!prio || String(r.priority) === prio) && (!activeOnly || r.active) && (!source || (r.source ?? "Myko") === source),
    );
    return [...list].sort((a, b) => {
      const x = sortVal(a, sort.key), y = sortVal(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.start.localeCompare(a.start);
    });
  }, [data, points, types, prio, activeOnly, sort, source]);
  const allTypes = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.alarm))].sort(), [data]);
  const activeByPoint = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.rows ?? []) if (r.active) m.set(r.pointId, (m.get(r.pointId) ?? 0) + 1);
    return m;
  }, [data]);
  const activeCount = (data?.rows ?? []).filter((r) => r.active).length;
  const unacked = rows.filter((r) => !r.acked);
  const plcFaults = (data?.plc ?? []).filter((p) => (p.errBits ?? 0) !== 0 || p.err === true);
  const plcRows = (data?.rows ?? []).filter((r) => r.source === "PLC" && !r.acked && (r.alarm === "ERRORBITS" || r.alarm === "PID_VIKA"));
  const doPlcAck = async () => {
    setAckBusy(true);
    try {
      const r = await plcErrorAckAll();
      if (r.error) toast.error(`PLC ErrorAck: ${r.error}`); else toast.success(`ErrorAck lähetetty ${r.pids.length} PID:lle · Myko-kuitattu ${r.mykoAck.acked.length}`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setAckBusy(false); setPlcOpen(false); setReload((x) => x + 1); }
  };
  const doAck = async () => {
    setAckBusy(true);
    try {
      const r = await ackAlarms(unacked.map((x) => x.id));
      toast.success(`Kuitattu ${r.acked.length} hälytystä`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setAckBusy(false); setAckOpen(false); setReload((x) => x + 1); }
  };
  const clickSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: k === "start" || k === "duration" ? -1 : 1 }));

  if (err) return <div className="text-xs text-destructive">{err}</div>;
  if (!data) return <div className="text-xs italic text-muted-foreground">Loading…</div>;

  return (
    <div className="@container flex h-full flex-col gap-2 text-sm" data-testid="alarm-list">
      <DialogPrimitive.Root open={plcOpen} onOpenChange={(o) => !o && !ackBusy && setPlcOpen(false)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/75" />
          <DialogPrimitive.Content data-testid="al-plc-confirm" aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[61] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-amber-400 bg-background p-4 shadow-2xl">
            <DialogPrimitive.Title className="text-xs font-mono uppercase text-amber-300">Vahvista kirjoitus PLC:lle – ErrorAck</DialogPrimitive.Title>
            <div className="mt-2 text-base font-semibold">Kuittaa PLC-viat kaikista PID-säätimistä ({(data.plc ?? []).length})?</div>
            <div className="mt-1 text-sm text-muted-foreground">Lähettää ErrorAck-pulssin PLC:lle jokaiselle PID:lle ja kuittaa vastaavat ERRORBITS/PID_VIKA-hälytykset Myko-listalta. Jos vika on yhä päällä (Error=1), se palaa.</div>
            <ul className="mt-2 space-y-0.5 text-sm tabular-nums">{(data.plc ?? []).map((p) => (
              <li key={p.key} className={(p.errBits ?? 0) !== 0 || p.err ? "font-semibold text-amber-300" : "text-muted-foreground"}>
                {p.key}: ErrorBits {hex(p.errBits ?? undefined)} · Error {p.err ? 1 : 0}{p.warn ? ` · Warning ${hex(p.warn)}` : ""}
              </li>))}</ul>
            {plcRows.length ? <div className="mt-1 text-xs text-muted-foreground">Myko-kuitataan: {plcRows.map((r) => `${r.pointId} ${r.alarm}`).join(", ")}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={ackBusy} onClick={() => setPlcOpen(false)} className="min-h-11 rounded-md border border-border px-4 text-sm">Peruuta</button>
              <button type="button" disabled={ackBusy} onClick={doPlcAck} autoFocus className="min-h-11 rounded-md border border-amber-300 bg-amber-300 px-5 text-sm font-semibold text-zinc-900 disabled:opacity-50">{ackBusy ? "Lähetetään…" : "Lähetä ErrorAck"}</button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <DialogPrimitive.Root open={ackOpen} onOpenChange={(o) => !o && !ackBusy && setAckOpen(false)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/75" />
          <DialogPrimitive.Content data-testid="al-ack-confirm" aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[61] w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-400 bg-background p-4 shadow-2xl">
            <DialogPrimitive.Title className="text-xs font-mono uppercase text-muted-foreground">Vahvista kuittaus – vain Myko-hälytyslista</DialogPrimitive.Title>
            <div className="mt-2 text-base font-semibold">Kuittaa {unacked.length} kuittaamatonta hälytystä listalta?</div>
            <div className="mt-1 text-sm text-muted-foreground">Koskee nykyisellä rajauksella näkyviä hälytyksiä. Kuittaus vain Mykossa (kirjataan tapahtumiin) – ei PLC:n ErrorAck, ei poista aktiivista hälytystä.</div>
            <ul className="mt-2 max-h-40 overflow-auto text-xs text-muted-foreground">{unacked.slice(0, 30).map((r) => <li key={r.id}>{fmtTime(r.start)} · {r.pointName} · <span className="font-mono">{r.alarm}</span></li>)}{unacked.length > 30 ? <li>… +{unacked.length - 30}</li> : null}</ul>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={ackBusy} onClick={() => setAckOpen(false)} className="min-h-11 rounded-md border border-border px-4 text-sm">Peruuta</button>
              <button type="button" disabled={ackBusy} onClick={doAck} autoFocus className="min-h-11 rounded-md border border-zinc-300 bg-zinc-200 px-5 text-sm font-semibold text-zinc-900 disabled:opacity-50">{ackBusy ? "Kuitataan…" : "Vahvista"}</button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <ChipGroup label="Mittauspiste" testId="al-points" allLabel="Kaikki pisteet" selected={points} onChange={setPoints}
        options={data.points.map((p) => ({ value: p.id, label: p.name, badge: activeByPoint.get(p.id) }))} />
      {allTypes.length > 0 && (
        <ChipGroup label="Hälytystyyppi" testId="al-types" allLabel="Kaikki tyypit" selected={types} onChange={setTypes} mono
          options={allTypes.map((t) => ({ value: t, label: t }))} />
      )}
      <div className="flex flex-wrap items-center gap-2" data-testid="al-filters">
        <select aria-label="Prioriteetti" value={prio} onChange={(e) => setPrio(e.target.value)} className={SEL}>
          <option value="">Kaikki prioriteetit</option>
          <option value="1">1 – hälytys</option>
          <option value="2">2 – varoitus</option>
        </select>
        <select aria-label="Lähde" value={source} onChange={(e) => setSource(e.target.value as "" | "PLC" | "Myko")} className={SEL} data-testid="al-source">
          <option value="">Kaikki lähteet</option>
          <option value="PLC">PLC</option>
          <option value="Myko">Myko</option>
        </select>
        <select aria-label="Aikaväli" value={hours} onChange={(e) => setHours(Number(e.target.value))} className={SEL}>
          {RANGES.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
        </select>
        <label className="flex min-h-11 items-center gap-2 px-1">
          <input type="checkbox" className="h-5 w-5" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Vain aktiiviset
        </label>
        <button type="button" data-testid="al-ack-all" disabled={!unacked.length || ackBusy} onClick={() => setAckOpen(true)}
          className={`min-h-11 rounded-md border px-3 text-sm font-semibold disabled:opacity-40 ${unacked.length ? "border-amber-400 bg-amber-400/15 text-amber-200" : "border-border text-muted-foreground"}`}>
          Kuittaa listalta ({unacked.length})
        </button>
        <button type="button" data-testid="al-plc-ack" disabled={ackBusy || !(data.plc ?? []).length} onClick={() => setPlcOpen(true)}
          className={`min-h-11 rounded-md border px-3 text-sm font-semibold disabled:opacity-40 ${plcFaults.length ? "border-amber-400 bg-amber-400/25 text-amber-100" : "border-border text-muted-foreground"}`}>
          <span className="mr-1 rounded bg-sky-700 px-1 text-[11px] font-bold text-white">PLC</span>Kuittaa PLC-viat{plcFaults.length ? ` (${plcFaults.length})` : ""}
        </button>
        <span className="ml-auto text-muted-foreground" data-testid="al-count">
          {activeCount > 0 ? <span className="text-foreground">{activeCount} aktiivista</span> : "Ei aktiivisia"} · {rows.length} riviä
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="py-4 text-center text-muted-foreground">Ei hälytyksiä valitulla rajauksella.</div>
      ) : (
        <>
          {/* wide: table */}
          <div className="hidden min-h-0 flex-1 overflow-auto rounded-md border border-border @2xl:block">
            <table className="w-full border-collapse text-sm" data-testid="al-table">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  {COLS.map(([k, label, cls]) => (
                    <th key={k} className={`p-0 font-medium ${cls}`} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                      <button type="button" onClick={() => clickSort(k)}
                        className={`flex min-h-9 w-full items-center gap-1 px-2 hover:text-foreground ${cls.includes("text-right") ? "justify-end" : ""} ${sort.key === k ? "text-foreground" : ""}`}>
                        {label}
                        {sort.key === k && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 last:border-0 hover:bg-secondary/30" data-active={r.active ? "1" : "0"}>
                    <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{fmtTime(r.start)}</td>
                    <td className="px-2 py-1.5"><SrcBadge r={r} /> {r.pointName}</td>
                    <td className={`px-2 py-1.5 font-mono ${activeText(r)}`}>{r.alarm}</td>
                    <td className="px-2 py-1.5"><Prio r={r} /></td>
                    <td className={`px-2 py-1.5 ${r.active ? "text-foreground" : "text-muted-foreground"}`}>
                      {r.active ? "Aktiivinen" : <span title={r.end ? `Poistunut ${fmtTime(r.end)}` : ""}>Poistunut</span>}
                      {!r.acked && <span className="ml-1 text-xs text-amber-300" title="Kuittaamaton">●</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.value === null ? "—" : `${r.value.toFixed(1)} ${r.unit}`}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{fmtDuration(r.durationSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* narrow / phone: cards */}
          <div className="flex min-h-0 flex-1 flex-col gap-2 @2xl:hidden" data-testid="al-cards">
            <select aria-label="Lajittelu" value={`${sort.key}:${sort.dir}`} className={SEL}
              onChange={(e) => { const [k, d] = e.target.value.split(":"); setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 }); }}>
              <option value="state:1">Aktiiviset ensin</option>
              <option value="start:-1">Uusin ensin</option>
              <option value="start:1">Vanhin ensin</option>
              <option value="priority:1">Prioriteetti</option>
              <option value="duration:-1">Pisin kesto</option>
              <option value="point:1">Mittauspiste A–Ö</option>
            </select>
            <ul className="max-h-[60vh] space-y-1.5 overflow-auto">
              {rows.map((r) => (
                <li key={r.id} className="flex items-start gap-2.5 rounded-md border border-border px-2.5 py-2" data-active={r.active ? "1" : "0"}>
                  <span className="mt-0.5"><Prio r={r} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`font-mono ${activeText(r)}`}>{r.alarm}</span>
                      <SrcBadge r={r} /><span className="truncate">{r.pointName}</span>
                      <span className={`ml-auto text-xs ${r.active ? "text-foreground" : "text-muted-foreground"}`}>{r.active ? "Aktiivinen" : "Poistunut"}{!r.acked ? " · kuittaamaton" : ""}</span>
                    </div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {fmtTime(r.start)} · {fmtDuration(r.durationSec)}{r.value !== null ? ` · ${r.value.toFixed(1)} ${r.unit}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

/** Multi-select as toggle chips (44 px). Empty selection = all. */
function ChipGroup({ label, options, selected, onChange, allLabel, testId, mono }: {
  label: string; options: { value: string; label: string; badge?: number }[]; selected: string[];
  onChange: (v: string[]) => void; allLabel: string; testId: string; mono?: boolean;
}) {
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const chip = (on: boolean) =>
    `min-h-11 rounded-md border px-3 text-sm transition-colors ${on ? "border-zinc-300 bg-zinc-200 font-semibold text-zinc-900" : "border-border text-muted-foreground hover:text-foreground"}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label} data-testid={testId}>
      <span className="w-full text-xs uppercase text-muted-foreground @md:w-auto @md:pr-1">{label}</span>
      <button type="button" aria-pressed={selected.length === 0} onClick={() => onChange([])} className={chip(selected.length === 0)}>{allLabel}</button>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={selected.includes(o.value)} onClick={() => toggle(o.value)}
          className={`${chip(selected.includes(o.value))} ${mono ? "font-mono" : ""} inline-flex items-center gap-1.5`}>
          {o.label}
          {o.badge ? <span className="rounded bg-red-600 px-1.5 text-xs font-bold text-white" title={`${o.badge} aktiivista`}>{o.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
