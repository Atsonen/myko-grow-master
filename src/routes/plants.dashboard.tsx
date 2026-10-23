import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getDataloggerLatest, type DataloggerLatest } from "@/lib/apiClient";

export const Route = createFileRoute("/plants/dashboard")({
  head: () => ({ meta: [{ title: "Plants dashboard - Myko Valvomo" }] }),
  component: PlantsDashboardPage,
});

// Signals identified by matching HMI screenshot values (23.10.2026 ~14:05) to datalogger values.
const TAGS = {
  level: "dl25", // Level %
  waterTemp: "dl24", // Water Temp
  ec: "dl23", // ppm
  ph: "dl26", // pH
  fan: "dl04", // PF-1 %
  ductTemp: "dl31", // G Poistoilma DS4
  roofTemp: "dl30", // G Katto DS3
  midTemp: "dl03", // G Mid DS2
  g1Temp: "dl09", // G1 temp TT
} as const;
type TagName = keyof typeof TAGS;
const POLL_MS = 5000;

function useLive() {
  const [vals, setVals] = useState<Partial<Record<TagName, DataloggerLatest>>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const rows = await getDataloggerLatest(Object.values(TAGS));
        if (!alive) return;
        const out: Partial<Record<TagName, DataloggerLatest>> = {};
        for (const [name, key] of Object.entries(TAGS)) {
          const r = rows.find((x) => x.variableKey === key);
          if (r) out[name as TagName] = r;
        }
        setVals(out);
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { vals, err };
}

const C = {
  bg: "#0f172a",
  panel: "#1e293b",
  stroke: "#334155",
  pipe: "#3b82f6",
  pipeOff: "#475569",
  water: "#38bdf8",
  text: "#e2e8f0",
  muted: "#64748b",
  on: "#22c55e",
  off: "#ef4444",
  na: "#475569",
};

function fmt(v: number | null | undefined, d: number) {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);
}

function ValueBox({ x, y, w = 92, label, value, unit, wired = true, title }: {
  x: number; y: number; w?: number; label: string; value?: string; unit?: string; wired?: boolean; title?: string;
}) {
  return (
    <g transform={`translate(${x},${y})`} opacity={wired ? 1 : 0.55}>
      <title>{title ?? label}</title>
      <rect width={w} height={40} rx={6} fill={C.panel} stroke={wired ? C.stroke : C.na} strokeDasharray={wired ? undefined : "4 3"} />
      <text x={8} y={14} fontSize={9} fill={C.muted} fontFamily="monospace">{label}</text>
      <text x={8} y={32} fontSize={wired ? 15 : 10} fill={wired ? C.text : C.muted} fontFamily="monospace" fontWeight={600}>
        {wired ? `${value ?? "—"}${unit ? ` ${unit}` : ""}` : "ei kytketty"}
      </text>
    </g>
  );
}

// state: true/false = ON/OFF, undefined = unwired
function Pump({ x, y, label, state, color = C.pipe }: { x: number; y: number; label: string; state?: boolean; color?: string }) {
  const wired = state !== undefined;
  const fill = !wired ? C.na : state ? C.on : C.off;
  return (
    <g transform={`translate(${x},${y})`} opacity={wired ? 1 : 0.6}>
      <title>{wired ? `${label}: ${state ? "PÄÄLLÄ" : "POIS"}` : `${label}: ei kytketty`}</title>
      <circle r={16} fill={C.panel} stroke={wired ? color : C.na} strokeWidth={3} />
      <path d="M -7 -8 L 9 0 L -7 8 Z" fill={wired ? color : C.na}>
        {wired && state && <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s" repeatCount="indefinite" />}
      </path>
      <text y={32} textAnchor="middle" fontSize={10} fill={C.text} fontFamily="monospace">{label}</text>
      <rect x={-22} y={38} width={44} height={16} rx={8} fill={fill} />
      <text y={50} textAnchor="middle" fontSize={9} fill="#fff" fontFamily="monospace" fontWeight={700}>
        {!wired ? "ei kytk." : state ? "ON" : "OFF"}
      </text>
    </g>
  );
}

function Tank({ x, y, w, h, level, label, sub }: { x: number; y: number; w: number; h: number; level?: number | null; label: string; sub?: string }) {
  const wired = level !== undefined;
  const pct = Math.max(0, Math.min(100, Number(level ?? 0)));
  const lh = (h * pct) / 100;
  const id = `clip-${label.replace(/\W/g, "")}`;
  return (
    <g transform={`translate(${x},${y})`}>
      <defs>
        <clipPath id={id}><rect width={w} height={h} rx={10} /></clipPath>
        <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={C.water} stopOpacity={0.9} />
          <stop offset="1" stopColor="#0369a1" stopOpacity={0.9} />
        </linearGradient>
      </defs>
      <rect width={w} height={h} rx={10} fill="#0b1220" stroke={C.stroke} strokeWidth={2} />
      {wired && (
        <g clipPath={`url(#${id})`}>
          <rect x={0} width={w} y={h - lh} height={lh} fill={`url(#${id}-g)`} style={{ transition: "all 1s ease" }} />
          <path d={`M0 ${h - lh} q ${w / 4} -5 ${w / 2} 0 t ${w / 2} 0 v 6 h ${-w} z`} fill={C.water} opacity={0.6} style={{ transition: "all 1s ease" }}>
            <animateTransform attributeName="transform" type="translate" values={`0 0; ${-w / 8} 0; 0 0`} dur="3s" repeatCount="indefinite" />
          </path>
        </g>
      )}
      <text x={w / 2} y={-8} textAnchor="middle" fontSize={11} fill={C.text} fontFamily="monospace">{label}</text>
      {sub && <text x={w / 2} y={h + 14} textAnchor="middle" fontSize={9} fill={C.muted} fontFamily="monospace">{sub}</text>}
    </g>
  );
}

function Btn({ x, y, w, label, badge }: { x: number; y: number; w: number; label: string; badge?: string }) {
  return (
    <g transform={`translate(${x},${y})`} opacity={0.5}>
      <title>{`${label}: ei kytketty (vain näyttö)`}</title>
      <rect width={w} height={26} rx={5} fill={C.panel} stroke={C.na} strokeDasharray="4 3" />
      <text x={w / 2} y={17} textAnchor="middle" fontSize={11} fill={C.muted} fontFamily="monospace">{label}</text>
      {badge !== undefined && (
        <g transform={`translate(${w - 4},-4)`}>
          <circle r={9} fill={C.na} />
          <text y={3} textAnchor="middle" fontSize={8} fill="#fff" fontFamily="monospace">{badge}</text>
        </g>
      )}
    </g>
  );
}

function Pipe({ d, active = false }: { d: string; active?: boolean }) {
  return (
    <g>
      <path d={d} fill="none" stroke={active ? C.pipe : C.pipeOff} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
      {active && (
        <path d={d} fill="none" stroke="#bfdbfe" strokeWidth={2} strokeDasharray="6 10" strokeLinecap="round">
          <animate attributeName="stroke-dashoffset" from="32" to="0" dur="1.2s" repeatCount="indefinite" />
        </path>
      )}
    </g>
  );
}

function PlantsDashboardPage() {
  const { vals, err } = useLive();
  const v = (k: TagName) => vals[k]?.value ?? null;
  const ts = vals.level?.timestamp ?? vals.ec?.timestamp;
  const fan = v("fan");

  return (
    <div className="p-4 space-y-3 max-w-6xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-mono flex items-center gap-2">
          <Gauge className="h-4 w-4" /> Kasvamo – prosessinäkymä
        </h1>
        <span className="text-xs font-mono text-muted-foreground">
          {err ? `Virhe: ${err}` : ts ? `Päivitetty ${new Date(ts).toLocaleTimeString("fi-FI")}` : "Ladataan…"} · päivitys {POLL_MS / 1000} s · vain luku
        </span>
      </div>
      <Card className="p-2 bg-card border-border overflow-x-auto">
        <svg viewBox="0 0 960 560" className="w-full min-w-[720px]" style={{ background: C.bg, borderRadius: 8 }}>
          {/* Air duct + fan */}
          <Pipe d="M 560 70 H 700" active={(fan ?? 0) > 0} />
          <Pipe d="M 780 70 H 870 Q 900 70 900 40" active={(fan ?? 0) > 0} />
          <g transform="translate(740,70)">
            <title>Tuuletin PF-1</title>
            <circle r={30} fill={C.panel} stroke={C.stroke} strokeWidth={3} />
            <g>
              {[0, 120, 240].map((a) => (
                <path key={a} d="M0 0 Q 8 -20 0 -24 Q -8 -20 0 0" fill={C.water} transform={`rotate(${a})`} />
              ))}
              {(fan ?? 0) > 0 && (
                <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur={`${Math.max(0.4, 3 - (fan ?? 0) / 40)}s`} repeatCount="indefinite" />
              )}
            </g>
            <circle r={4} fill={C.text} />
          </g>
          <ValueBox x={694} y={108} label="Tuuletin PF-1" value={fmt(fan, 1)} unit="%" title={`${TAGS.fan} PF-1 %`} />
          <ValueBox x={560} y={92} label="Poistoilma" value={fmt(v("ductTemp"), 1)} unit="°C" title={`${TAGS.ductTemp} G Poistoilma DS4`} />

          {/* Air temps */}
          <ValueBox x={400} y={60} label="Katto" value={fmt(v("roofTemp"), 1)} unit="°C" title={`${TAGS.roofTemp} G Katto DS3`} />
          <ValueBox x={400} y={110} label="Keskiosa" value={fmt(v("midTemp"), 1)} unit="°C" title={`${TAGS.midTemp} G Mid DS2`} />
          <Btn x={500} y={117} w={28} label="S" />

          {/* Top bar buttons (HMI) */}
          <Btn x={20} y={16} w={90} label="Asetukset" />
          <Btn x={118} y={16} w={50} label="EC" />
          <Btn x={176} y={16} w={50} label="PH" />
          <Btn x={20} y={50} w={28} label="S" />
          <Btn x={840} y={110} w={90} label="Hälytykset" badge="?" />
          <Btn x={840} y={146} w={90} label="Kuittaus" />
          {/* yellow status bars */}
          <g opacity={0.5}>
            <title>Tilapalkki: ei kytketty</title>
            <rect x={40} y={150} width={70} height={14} rx={3} fill={C.na} />
            <rect x={620} y={150} width={70} height={14} rx={3} fill={C.na} />
            <text x={75} y={180} textAnchor="middle" fontSize={9} fill={C.muted} fontFamily="monospace">ei kytketty</text>
            <text x={655} y={180} textAnchor="middle" fontSize={9} fill={C.muted} fontFamily="monospace">ei kytketty</text>
          </g>

          {/* Pipes */}
          <Pipe d="M 60 360 V 260 H 300 V 320" />
          <Pipe d="M 160 420 V 350 H 330" />
          <Pipe d="M 360 320 V 230 H 800 V 360" />
          <Pipe d="M 400 320 V 270 H 690 V 360" />

          {/* Main tank */}
          <Tank x={300} y={320} w={130} h={200} level={v("level")} label="Ravinnesäiliö" />
          <ValueBox x={442} y={330} w={100} label="Pinta" value={fmt(v("level"), 1)} unit="%" title={`${TAGS.level} Level`} />
          <ValueBox x={442} y={376} w={100} label="Vesi" value={fmt(v("waterTemp"), 1)} unit="°C" title={`${TAGS.waterTemp} Water Temp`} />
          <ValueBox x={442} y={422} w={100} label="EC" value={fmt(v("ec"), 0)} unit="ppm" title={`${TAGS.ec} ppm`} />
          <ValueBox x={442} y={468} w={100} label="pH" value={fmt(v("ph"), 2)} title={`${TAGS.ph} pH`} />
          <g opacity={0.55}>
            <title>Lämmitin: ei kytketty</title>
            <rect x={300} y={530} width={130} height={14} rx={3} fill={C.na} />
            <text x={365} y={541} textAnchor="middle" fontSize={9} fill="#fff" fontFamily="monospace">Lämmitin – ei kytketty</text>
          </g>

          {/* G1 temp + timer */}
          <ValueBox x={560} y={280} w={100} label="G1 lämpötila" value={fmt(v("g1Temp"), 1)} unit="°C" title={`${TAGS.g1Temp} G1 temp TT`} />
          <Btn x={666} y={287} w={28} label="S" />
          <ValueBox x={560} y={226} w={100} label="Ajastin" wired={false} />

          {/* Left: water tank + pumps */}
          <Tank x={20} y={420} w={90} h={100} label="Vesisäiliö" sub="pinta ei kytketty" />
          <Pump x={60} y={330} label="Vesipumppu" />
          <Pump x={160} y={410} label="Lannoite" />
          <Tank x={135} y={470} w={50} h={50} label="" sub="Ferts" />
          <ValueBox x={200} y={470} w={92} label="Lämmitin T" wired={false} />

          {/* pH dosing */}
          <Pump x={590} y={430} label="pH+" color="#f43f5e" />
          <Pump x={670} y={430} label="pH−" color="#f43f5e" />

          {/* Right tanks */}
          <Pump x={690} y={350} label="" />
          <Tank x={730} y={420} w={90} h={100} label="" sub="Säiliö 2" />
          <Pump x={800} y={350} label="" />
          <Tank x={840} y={420} w={90} h={100} label="" sub="Säiliö 3" />
        </svg>
      </Card>
      <div className="text-[11px] font-mono text-muted-foreground leading-relaxed">
        Harmaat katkoviivalla merkityt elementit: <b>ei kytketty</b> – signaalia ei ole tunnistettu Myko-datasta varmasti
        (pumppujen/lämmittimien tilat, hälytykset, ajastin, painikkeet). Kytketyt arvot: Datalogger {Object.values(TAGS).join(", ")}.
      </div>
    </div>
  );
}
