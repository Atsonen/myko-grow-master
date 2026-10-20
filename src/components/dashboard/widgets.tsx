import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { StatusBadge } from "@/components/common/StatusBadge";
import { FunctionBadge } from "@/components/common/FunctionBadge";
import { getTrendSeries, getUnitEnvironment, type TrendBucket, type UnitEnvironment } from "@/lib/apiClient";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useDashboardData } from "./DashboardData";
import { STATUSES, type DashboardWidget, type WidgetConfigMap } from "./types";

const COLORS = ["#f97316", "#38bdf8", "#a3e635", "#e879f9", "#facc15", "#f87171"];
const SENTINEL = -100; // DS18B20 "-127" disconnected values

function Muted({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted-foreground italic">{children}</div>;
}

function fmtNumber(v: number | null | undefined, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(digits);
}

function bucketFor(rangeHours: number): TrendBucket {
  if (rangeHours <= 12) return "raw";
  if (rangeHours <= 24 * 21) return "hour";
  return "day";
}

/* ---------------- Sensor latest value ---------------- */
export function SensorLatestWidget({ config }: { config: WidgetConfigMap["sensorLatest"] }) {
  const { variables, tick } = useDashboardData();
  const variable = variables.find((v) => v.id === config.variableId);
  const [point, setPoint] = useState<{ value: number; timestamp: string } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!config.variableId) return;
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 3600_000);
    getTrendSeries({ variableId: config.variableId, from: from.toISOString(), to: to.toISOString(), bucket: "raw" })
      .then((pts) => {
        if (cancelled) return;
        const valid = pts.filter((p) => p.value > SENTINEL);
        const last = valid[valid.length - 1];
        setPoint(last ? { value: last.value, timestamp: last.timestamp } : null);
        setErr("");
      })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [config.variableId, tick]);

  if (!config.variableId) return <Muted>Pick a sensor in widget settings.</Muted>;
  return (
    <div className="flex h-full flex-col justify-center">
      <div className="text-[10px] font-mono uppercase text-muted-foreground truncate">
        {variable?.label ?? config.variableId}
      </div>
      <div className="font-mono text-3xl tabular-nums">
        {point ? fmtNumber(point.value, 2) : "—"}
        <span className="ml-1 text-sm text-muted-foreground">{variable?.unit ?? ""}</span>
      </div>
      <div className="text-[10px] text-muted-foreground">
        {err ? err : point ? relativeTime(point.timestamp) : "no data in last 3 h"}
      </div>
    </div>
  );
}

/* ---------------- Trend chart ---------------- */
export function TrendWidget({ config }: { config: WidgetConfigMap["trend"] }) {
  const { variables, tick } = useDashboardData();
  const ids = config.variableIds ?? [];
  const rangeHours = config.rangeHours ?? 24;
  const [series, setSeries] = useState<Record<string, { ts: number; value: number }[]>>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - rangeHours * 3600_000);
    const bucket = bucketFor(rangeHours);
    Promise.all(
      ids.map((id) =>
        getTrendSeries({ variableId: id, from: from.toISOString(), to: to.toISOString(), bucket }).then(
          (pts) => [id, pts.filter((p) => p.value > SENTINEL).map((p) => ({ ts: new Date(p.timestamp).getTime(), value: p.value }))] as const,
        ),
      ),
    )
      .then((entries) => {
        if (cancelled) return;
        setSeries(Object.fromEntries(entries));
        setErr("");
      })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join("|"), rangeHours, tick]);

  const data = useMemo(() => {
    const byTs = new Map<number, Record<string, number>>();
    for (const [id, pts] of Object.entries(series)) {
      for (const p of pts) {
        const row = byTs.get(p.ts) ?? { ts: p.ts };
        row[id] = p.value;
        byTs.set(p.ts, row);
      }
    }
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }, [series]);

  if (ids.length === 0) return <Muted>Pick variables in widget settings.</Muted>;
  if (err) return <div className="text-xs text-destructive">{err}</div>;
  if (data.length === 0) return <Muted>No data for the last {rangeHours} h.</Muted>;
  const tickFmt = (ts: number) =>
    rangeHours <= 48
      ? new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "numeric" });
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={tickFmt} tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
        <Tooltip labelFormatter={(ts) => formatDateTime(new Date(Number(ts)).toISOString())} contentStyle={{ fontSize: 11 }} />
        <Legend wrapperStyle={{ fontSize: 10 }} />
        {ids.map((id, i) => (
          <Line
            key={id}
            dataKey={id}
            name={variables.find((v) => v.id === id)?.label ?? id}
            stroke={COLORS[i % COLORS.length]}
            dot={false}
            strokeWidth={1.5}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* ---------------- Units by status ---------------- */
export function UnitsByStatusWidget({ config }: { config: WidgetConfigMap["unitsByStatus"] }) {
  const { units } = useDashboardData();
  if ((config.mode ?? "count") === "count") {
    return (
      <div className="grid grid-cols-1 gap-1">
        {STATUSES.map((s) => (
          <div key={s} className="flex items-center justify-between rounded border border-border bg-secondary/20 px-2 py-1">
            <StatusBadge status={s} />
            <span className="font-mono text-lg tabular-nums">{units.filter((u) => u.status === s).length}</span>
          </div>
        ))}
      </div>
    );
  }
  const status = config.status ?? "ACTIVE";
  const list = units.filter((u) => u.status === status).sort((a, b) => b.batchTime.localeCompare(a.batchTime));
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-mono uppercase text-muted-foreground">
        {list.length} × {status}
      </div>
      {list.map((u) => (
        <Link
          key={u.code}
          to="/units/$unitCode"
          params={{ unitCode: u.code }}
          className="flex items-center justify-between gap-2 rounded border border-border bg-secondary/20 px-2 py-1 text-xs hover:bg-secondary"
        >
          <span className="font-mono truncate">{u.code}</span>
          <span className="text-[10px] text-muted-foreground">{u.currentLocation ?? ""}</span>
        </Link>
      ))}
      {list.length === 0 && <Muted>None.</Muted>}
    </div>
  );
}

/* ---------------- Recent events ---------------- */
export function RecentEventsWidget({ config }: { config: WidgetConfigMap["recentEvents"] }) {
  const { events, units } = useDashboardData();
  const list = useMemo(() => {
    const archived = new Set(units.filter((u) => u.status === "ARCHIVED").map((u) => u.code));
    return events
        .filter((e) => !e.archived && !archived.has(e.unitCode) && (!config.functionCode || e.functionCode === config.functionCode))
        .sort((a, b) => b.eventTime.localeCompare(a.eventTime))
        .slice(0, config.limit ?? 8);
  }, [events, units, config.functionCode, config.limit]);
  return (
    <div className="space-y-1">
      {list.map((e) => (
        <Link
          key={e.id}
          to="/units/$unitCode"
          params={{ unitCode: e.unitCode }}
          className="block rounded border border-border bg-secondary/20 px-2 py-1 text-xs hover:bg-secondary"
        >
          <div className="flex items-center gap-2">
            <FunctionBadge code={e.functionCode} />
            <span className="font-mono truncate">{e.unitCode}</span>
            <span className="ml-auto text-[10px] text-muted-foreground whitespace-nowrap">{relativeTime(e.eventTime)}</span>
          </div>
          <div className="truncate text-muted-foreground">{e.title}</div>
        </Link>
      ))}
      {list.length === 0 && <Muted>No events.</Muted>}
    </div>
  );
}

/* ---------------- Location summary ---------------- */
export function LocationSummaryWidget() {
  const { units, readings } = useDashboardData();
  const rows = useMemo(() => {
    const map = new Map<string, { count: number; temp?: number; ts?: string }>();
    for (const u of units) {
      if (u.status !== "ACTIVE" || !u.currentLocation) continue;
      const r = map.get(u.currentLocation) ?? { count: 0 };
      r.count += 1;
      map.set(u.currentLocation, r);
    }
    for (const reading of readings) {
      if (typeof reading.temperatureC !== "number" || reading.temperatureC <= SENTINEL) continue;
      const r = map.get(reading.location) ?? { count: 0 };
      r.temp = reading.temperatureC;
      r.ts = reading.timestamp;
      map.set(reading.location, r);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [units, readings]);
  const unplaced = units.filter((u) => u.status === "ACTIVE" && !u.currentLocation).length;
  return (
    <div className="space-y-1">
      {rows.map(([loc, r]) => (
        <Link
          key={loc}
          to="/environment"
          className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded border border-border bg-secondary/20 px-2 py-1 text-xs hover:bg-secondary"
        >
          <span className="font-mono truncate">{loc}</span>
          <span className="text-muted-foreground">{r.count} units</span>
          <span className="font-mono tabular-nums text-base">{r.temp !== undefined ? `${fmtNumber(r.temp)} °C` : "—"}</span>
        </Link>
      ))}
      {rows.length === 0 && <Muted>No locations yet.</Muted>}
      <div className="text-[10px] text-muted-foreground">{unplaced} active units without a location</div>
    </div>
  );
}

/* ---------------- Unit lifetime curve ---------------- */
export function UnitCurveWidget({ config }: { config: WidgetConfigMap["unitCurve"] }) {
  const { tick } = useDashboardData();
  const [env, setEnv] = useState<UnitEnvironment | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!config.unitCode) return;
    let cancelled = false;
    getUnitEnvironment(config.unitCode, 300)
      .then((e) => !cancelled && (setEnv(e), setErr("")))
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [config.unitCode, tick]);

  if (!config.unitCode) return <Muted>Pick a unit in widget settings.</Muted>;
  if (err) return <div className="text-xs text-destructive">{err}</div>;
  if (!env) return <Muted>Loading…</Muted>;
  if (env.points.length === 0)
    return <Muted>No sensor data for {config.unitCode} (no location history or no readings).</Muted>;
  const data = env.points.map((p) => ({ ts: new Date(p.timestamp).getTime(), t: p.temperatureC, rh: p.humidityRh }));
  const hasRh = data.some((d) => d.rh !== null);
  return (
    <div className="flex h-full flex-col">
      <Link to="/units/$unitCode" params={{ unitCode: env.unitCode }} className="text-[10px] font-mono text-primary hover:underline">
        {env.unitCode} · {formatDateTime(env.from)} → {env.ended ? formatDateTime(env.to) : "now"}
      </Link>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tick={{ fontSize: 10 }}
              tickFormatter={(ts) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "numeric" })} />
            <YAxis yAxisId="t" tick={{ fontSize: 10 }} />
            {hasRh && <YAxis yAxisId="rh" orientation="right" domain={[0, 100]} tick={{ fontSize: 10 }} />}
            <Tooltip labelFormatter={(ts) => formatDateTime(new Date(Number(ts)).toISOString())} contentStyle={{ fontSize: 11 }} />
            <Line yAxisId="t" dataKey="t" name="Temp °C" stroke={COLORS[0]} dot={false} isAnimationActive={false} />
            {hasRh && <Line yAxisId="rh" dataKey="rh" name="RH %" stroke={COLORS[1]} dot={false} isAnimationActive={false} />}
            {env.moves.map((m) => (
              <ReferenceLine key={m.id} yAxisId="t" x={new Date(m.movedAt).getTime()} stroke="#a3a3a3" strokeDasharray="4 2"
                label={{ value: `→ ${m.location}`, position: "insideTopLeft", fontSize: 9, fill: "#a3a3a3" }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ---------------- Note ---------------- */
export function NoteWidget({ config }: { config: WidgetConfigMap["note"] }) {
  return <div className="whitespace-pre-wrap text-sm">{config.text || <Muted>Empty note — edit in settings.</Muted>}</div>;
}

export function WidgetBody({ widget }: { widget: DashboardWidget }) {
  switch (widget.type) {
    case "sensorLatest":
      return <SensorLatestWidget config={widget.config as WidgetConfigMap["sensorLatest"]} />;
    case "trend":
      return <TrendWidget config={widget.config as WidgetConfigMap["trend"]} />;
    case "unitsByStatus":
      return <UnitsByStatusWidget config={widget.config as WidgetConfigMap["unitsByStatus"]} />;
    case "recentEvents":
      return <RecentEventsWidget config={widget.config as WidgetConfigMap["recentEvents"]} />;
    case "locationSummary":
      return <LocationSummaryWidget />;
    case "unitCurve":
      return <UnitCurveWidget config={widget.config as WidgetConfigMap["unitCurve"]} />;
    case "note":
      return <NoteWidget config={widget.config as WidgetConfigMap["note"]} />;
    default:
      return <Muted>Unknown widget type.</Muted>;
  }
}

export function defaultTitle(widget: DashboardWidget, labelFor: (id: string) => string | undefined) {
  switch (widget.type) {
    case "sensorLatest": {
      const id = (widget.config as WidgetConfigMap["sensorLatest"]).variableId;
      return (id && labelFor(id)) || "Sensor value";
    }
    case "trend":
      return `Trend · ${(widget.config as WidgetConfigMap["trend"]).rangeHours ?? 24} h`;
    case "unitsByStatus": {
      const c = widget.config as WidgetConfigMap["unitsByStatus"];
      return c.mode === "list" ? `${c.status ?? "ACTIVE"} units` : "Units by status";
    }
    case "recentEvents":
      return "Recent events";
    case "locationSummary":
      return "Locations";
    case "unitCurve":
      return `Lifetime · ${(widget.config as WidgetConfigMap["unitCurve"]).unitCode ?? "unit"}`;
    case "note":
      return "Note";
  }
}
