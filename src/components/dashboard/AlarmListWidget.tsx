import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { getAlarmSummary, type AlarmSummary, type AlarmSummaryRow } from "@/lib/apiClient";
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
  const limit = config.limit ?? 200;

  useEffect(() => { setHours(config.hours ?? 24); }, [config.hours]);
  useEffect(() => {
    let cancelled = false;
    getAlarmSummary(hours, limit)
      .then((d) => { if (!cancelled) { setData(d); setErr(""); } })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => { cancelled = true; };
  }, [hours, limit, tick]);

  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter(
      (r) => (!points.length || points.includes(r.pointId)) && (!types.length || types.includes(r.alarm)) && (!prio || String(r.priority) === prio) && (!activeOnly || r.active),
    );
    return [...list].sort((a, b) => {
      const x = sortVal(a, sort.key), y = sortVal(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.start.localeCompare(a.start);
    });
  }, [data, points, types, prio, activeOnly, sort]);
  const allTypes = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.alarm))].sort(), [data]);
  const activeByPoint = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.rows ?? []) if (r.active) m.set(r.pointId, (m.get(r.pointId) ?? 0) + 1);
    return m;
  }, [data]);
  const activeCount = (data?.rows ?? []).filter((r) => r.active).length;
  const clickSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: k === "start" || k === "duration" ? -1 : 1 }));

  if (err) return <div className="text-xs text-destructive">{err}</div>;
  if (!data) return <div className="text-xs italic text-muted-foreground">Loading…</div>;

  return (
    <div className="@container flex h-full flex-col gap-2 text-sm" data-testid="alarm-list">
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
        <select aria-label="Aikaväli" value={hours} onChange={(e) => setHours(Number(e.target.value))} className={SEL}>
          {RANGES.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
        </select>
        <label className="flex min-h-11 items-center gap-2 px-1">
          <input type="checkbox" className="h-5 w-5" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Vain aktiiviset
        </label>
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
                    <td className="px-2 py-1.5">{r.pointName}</td>
                    <td className={`px-2 py-1.5 font-mono ${activeText(r)}`}>{r.alarm}</td>
                    <td className="px-2 py-1.5"><Prio r={r} /></td>
                    <td className={`px-2 py-1.5 ${r.active ? "text-foreground" : "text-muted-foreground"}`}>
                      {r.active ? "Aktiivinen" : <span title={r.end ? `Poistunut ${fmtTime(r.end)}` : ""}>Poistunut</span>}
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
                      <span className="truncate">{r.pointName}</span>
                      <span className={`ml-auto text-xs ${r.active ? "text-foreground" : "text-muted-foreground"}`}>{r.active ? "Aktiivinen" : "Poistunut"}</span>
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
