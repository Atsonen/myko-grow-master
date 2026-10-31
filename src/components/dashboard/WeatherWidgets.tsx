import { useEffect, useState } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { requestJson } from "@/lib/apiClient";
import { useDashboardData } from "./DashboardData";

type Fc = { time: string; t: number | null; rh: number | null; ws: number | null; wg: number | null; wd: number | null; cloud: number | null; precip: number | null; symbol: number | null };
type WeatherResp = {
  station: { name: string; windStation: string };
  current: { time: string; t: number | null; rh: number | null; td: number | null; cloudOkta: number | null; precip1h: number | null; precip24h: number | null; pressure: number | null; ws: number | null; wg: number | null; wd: number | null } | null;
  forecast: Fc[];
};
type SpaceResp = {
  kpNow: number | null; kpMax24h: number | null;
  kpObserved: { time: string; kp: number }[];
  kpForecast: { time: string; kp: number | null; kind: string; scale: string | null }[];
  solarWind: { time: string | null; speed: number | null; density: number | null; bz: number | null; bt: number | null };
  magnetometer: { station: string; dx1h: number | null; lastTime: string | null; series: { time: string; x: number }[] } | null;
  aurora: { level: number; text: string; dark: boolean; cloudOkta: number | null; note: string | null };
  errors: string[];
};

function usePoll<T>(url: string, everyMs = 10 * 60_000) {
  const { tick } = useDashboardData();
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = () => requestJson<T>(url).then((d) => { if (!cancelled) { setData(d); setErr(""); } }).catch((e) => !cancelled && setErr((e as Error).message));
    load();
    const id = setInterval(load, everyMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [url, everyMs, tick]);
  return { data, err };
}

const f = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(d));
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Helsinki" });
const dayHour = (iso: string) => new Date(iso).toLocaleString("fi-FI", { weekday: "short", hour: "2-digit", timeZone: "Europe/Helsinki" });
const DIRS = ["P", "KO", "I", "KA", "E", "LO", "L", "LU"];
const dir = (deg: number | null) => (deg == null ? "" : DIRS[Math.round(deg / 45) % 8]);

/** FMI WeatherSymbol3 -> emoji */
function sym(s: number | null | undefined) {
  if (s == null) return "";
  if (s === 1) return "☀️";
  if (s === 2) return "🌤️";
  if (s === 3) return "☁️";
  if (s >= 21 && s <= 23) return "🌦️";
  if (s >= 31 && s <= 33) return "🌧️";
  if (s >= 41 && s <= 53) return "🌨️";
  if (s >= 61 && s <= 64) return "⛈️";
  if (s >= 71 && s <= 83) return "🌨️";
  if (s === 91 || s === 92) return "🌫️";
  return "☁️";
}

export function WeatherWidget() {
  const { data, err } = usePoll<WeatherResp>("/api/weather/fmi");
  if (err && !data) return <div className="text-xs text-destructive">{err}</div>;
  if (!data) return <div className="text-xs text-muted-foreground italic">Ladataan säätä…</div>;
  const c = data.current;
  const fc = data.forecast.slice(0, 48);
  const chart = fc.map((x) => ({ ts: Date.parse(x.time), t: x.t, p: x.precip }));
  const next = fc.filter((_, i) => i % 3 === 0).slice(0, 8);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div className="font-mono text-3xl tabular-nums">{sym(fc[0]?.symbol)} {f(c?.t)}<span className="text-sm text-muted-foreground"> °C</span></div>
        <div className="grid grid-cols-2 gap-x-3 font-mono">
          <span>RH {f(c?.rh, 0)} %</span>
          <span>Tuuli {f(c?.ws)} ({f(c?.wg)}) m/s {dir(c?.wd ?? null)}</span>
          <span>Pilvisyys {c?.cloudOkta == null ? "—" : `${c.cloudOkta}/8`}</span>
          <span>Sade {f(c?.precip1h)} mm/h · 24 h {f(c?.precip24h)} mm</span>
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto">
        {next.map((x) => (
          <div key={x.time} className="min-w-[3.2rem] rounded border border-border bg-secondary/20 px-1 py-0.5 text-center">
            <div className="text-[10px] text-muted-foreground">{dayHour(x.time)}</div>
            <div>{sym(x.symbol)}</div>
            <div className="font-mono">{f(x.t, 0)}°</div>
            <div className="text-[10px] text-sky-400">{x.precip ? `${f(x.precip)}mm` : ""}</div>
          </div>
        ))}
      </div>
      <div className="min-h-[80px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chart} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(ts: number) => hhmm(new Date(ts).toISOString())} tick={{ fontSize: 10 }} />
            <YAxis yAxisId="t" tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
            <YAxis yAxisId="p" orientation="right" hide domain={[0, (m: number) => Math.max(2, m * 2)]} />
            <Tooltip labelFormatter={(ts) => dayHour(new Date(Number(ts)).toISOString())} contentStyle={{ fontSize: 11 }} formatter={(v: number, n: string) => [n === "t" ? `${f(v)} °C` : `${f(v)} mm`, n === "t" ? "Lämpötila" : "Sade"]} />
            <Bar yAxisId="p" dataKey="p" fill="#38bdf8" opacity={0.6} />
            <Line yAxisId="t" dataKey="t" stroke="#f97316" dot={false} strokeWidth={2} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10px] text-muted-foreground">
        FMI: {data.station.name} (tuuli {data.station.windStation}) {c ? `klo ${hhmm(c.time)}` : ""} · ennuste Rajamäki 48 h
      </div>
    </div>
  );
}

const LEVEL_COLOR = ["text-muted-foreground", "text-lime-400", "text-yellow-400", "text-orange-400", "text-red-500"];
const kpColor = (kp: number | null) => (kp == null ? "#64748b" : kp >= 6 ? "#ef4444" : kp >= 5 ? "#f97316" : kp >= 4 ? "#facc15" : "#22c55e");


type OutdoorResp = { t: number | null; time: string | null; symbol: number | null; station: string; location: string; source: string; fetchedAt: string };

/** Compact outdoor temperature card (Rajamäki / FMI Röykkä). */
export function OutdoorTempWidget() {
  const { data, err } = usePoll<OutdoorResp>("/api/weather/outdoor");
  if (err && !data) return <div className="text-xs text-destructive">{err}</div>;
  if (!data) return <div className="text-xs text-muted-foreground italic">Ladataan…</div>;
  return (
    <div className="@container flex h-full min-h-0 flex-col justify-center overflow-hidden px-1" data-testid="outdoor-temp">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xl leading-none @[10rem]:text-2xl" aria-hidden>{sym(data.symbol)}</span>
        <span className="text-3xl font-semibold tabular-nums text-foreground @[10rem]:text-4xl @[14rem]:text-5xl" data-testid="outdoor-t">
          {data.t == null ? "—" : data.t.toFixed(1)}
        </span>
        <span className="text-sm text-muted-foreground @[10rem]:text-base">°C</span>
      </div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground @[10rem]:text-xs" title={`${data.location} · ${data.station}${data.time ? ` · klo ${hhmm(typeof data.time === "string" ? data.time : new Date(data.time).toISOString())}` : ""}`}>
        {data.location} · {data.station}
        {data.time ? ` · klo ${hhmm(typeof data.time === "string" ? data.time : new Date(data.time).toISOString())}` : ""}
      </div>
    </div>
  );
}

export function SpaceWeatherWidget() {
  const { data, err } = usePoll<SpaceResp>("/api/space-weather");
  if (err && !data) return <div className="text-xs text-destructive">{err}</div>;
  if (!data) return <div className="text-xs text-muted-foreground italic">Ladataan avaruussäätä…</div>;
  const sw = data.solarWind;
  const kpBars = data.kpForecast.map((k) => ({ ts: Date.parse(k.time), kp: k.kp, kind: k.kind }));
  const now = Date.now();
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div>
          <div className="text-[10px] uppercase text-muted-foreground">Kp nyt</div>
          <div className="font-mono text-3xl tabular-nums" style={{ color: kpColor(data.kpNow) }}>{f(data.kpNow, 1)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-muted-foreground">Revontulet Rajamäellä</div>
          <div className={`text-base font-semibold ${LEVEL_COLOR[data.aurora.level] ?? ""}`}>{data.aurora.text}</div>
          <div className="text-[10px] text-muted-foreground">
            {data.aurora.dark ? "Pimeää" : "Valoisaa"}
            {data.aurora.cloudOkta != null ? ` · pilvisyys ${data.aurora.cloudOkta}/8` : ""}
            {data.aurora.note ? ` · ${data.aurora.note}` : ""}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 font-mono">
          <span>Kp max 24 h: {f(data.kpMax24h, 1)}</span>
          <span>NUR ΔX 1 h: {f(data.magnetometer?.dx1h ?? null, 0)} nT</span>
          <span>Aurinkotuuli {f(sw.speed, 0)} km/s</span>
          <span className={sw.bz != null && sw.bz < -5 ? "text-orange-400" : ""}>Bz {f(sw.bz)} nT (Bt {f(sw.bt)})</span>
          <span>Tiheys {f(sw.density)} p/cm³</span>
        </div>
      </div>
      <div className="min-h-[80px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={kpBars} margin={{ top: 4, right: 0, left: -25, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(ts: number) => dayHour(new Date(ts).toISOString())} tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 9]} ticks={[0, 3, 5, 7, 9]} tick={{ fontSize: 10 }} />
            <ReferenceLine y={4} stroke="#facc15" strokeDasharray="4 4" />
            <ReferenceLine x={now} stroke="#94a3b8" />
            <Tooltip labelFormatter={(ts) => dayHour(new Date(Number(ts)).toISOString())} contentStyle={{ fontSize: 11 }}
              formatter={(v: number, _n: string, p: { payload?: { kind?: string } }) => [f(v, 2), `Kp (${p.payload?.kind === "observed" ? "havaittu" : p.payload?.kind === "estimated" ? "arvio" : "ennuste"})`]} />
            <Bar dataKey="kp" isAnimationActive={false}>
              {kpBars.map((b) => <Cell key={b.ts} fill={kpColor(b.kp)} fillOpacity={b.kind === "predicted" ? 0.5 : 0.9} />)}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10px] text-muted-foreground">
        NOAA SWPC (Kp 3 h, haalea = ennuste; aurinkotuuli L1) · FMI Nurmijärven observatorio (magnetometri). Kp ≥ 4 tai ΔX ≥ 80 nT → mahdollisia revontulia.
        {data.errors.length ? ` · Virhe: ${data.errors.join("; ")}` : ""}
      </div>
    </div>
  );
}
