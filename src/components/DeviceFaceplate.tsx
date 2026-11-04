// Shared faceplate building blocks for device detail dialogs (EC-style).
import type { ReactNode } from "react";
import type { PumpRunInterval, PumpRunMeta } from "@/lib/apiClient";

export function DfBadge({ kind, children }: { kind: "alarm" | "warning" | "ok" | "info" | "muted" | "live" | "run"; children: ReactNode }) {
  const c = {
    alarm: "bg-red-600 text-white",
    warning: "bg-amber-400 text-zinc-900",
    ok: "bg-emerald-600 text-white",
    info: "bg-sky-700 text-white",
    muted: "bg-zinc-700 text-zinc-200",
    live: "bg-violet-600 text-white",
    run: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
  }[kind];
  return <span className={`inline-block rounded px-1.5 py-px text-[11px] font-bold uppercase tracking-wide ${c}`}>{children}</span>;
}

export function DfSection({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function DfKV({ k, v, cls }: { k: string; v: ReactNode; cls?: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-border/40 py-0.5 last:border-0">
      <span className="text-muted-foreground">{k}</span>
      <span className={`tabular-nums ${cls ?? ""}`}>{v}</span>
    </div>
  );
}

export function DfSwitch({ on, label, onClick, disabled, title, testid }: {
  on: boolean; label: string; onClick: () => void; disabled?: boolean; title?: string; testid?: string;
}) {
  return (
    <button type="button" data-testid={testid} disabled={disabled} title={title} onClick={onClick}
      className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm transition-colors disabled:opacity-50 ${on ? "border-emerald-500/60 bg-emerald-500/10" : "border-border bg-muted/20 hover:bg-muted/40"}`}>
      <span>{label}</span>
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-emerald-500" : "bg-zinc-600"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

/** ~2.5 min — do not draw L across larger holes (new M segment). */
export const DF_TREND_GAP_MS = 150_000;

/** Build SVG path d; start a new M when consecutive points are farther than gapMs. */
export function buildSpBandPath(
  pts: [number, number][],
  x: (t: number) => number,
  y: (v: number) => number,
  gapMs = DF_TREND_GAP_MS,
): string {
  let d = "";
  let prevT: number | null = null;
  for (const [t, v] of pts) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    const cmd = prevT != null && t - prevT <= gapMs ? "L" : "M";
    d += `${cmd}${x(t).toFixed(1)},${y(v).toFixed(1)} `;
    prevT = t;
  }
  return d.trim();
}

/** Line trend with optional SP ± hyst band (and optional absolute min/max dashed lines). */
export function DfSpBandTrend({
  pts, sp, hyst, min, max, unit = "%", testid = "df-trend", emptyHint = "Trendi kertyy (1 min näytteet, ~24 h)…",
  tStart, tEnd, gapMs = DF_TREND_GAP_MS,
  pumpIntervals, pumpMeta, pumpVisible,
}: {
  pts: [number, number][];
  sp?: number | null;
  hyst?: number | null;
  min?: number | null;
  max?: number | null;
  unit?: string;
  testid?: string;
  emptyHint?: string;
  /** Fixed X window (ms). When set, axis spans the window even if pts are sparse. */
  tStart?: number;
  tEnd?: number;
  gapMs?: number;
  pumpIntervals?: PumpRunInterval[];
  pumpMeta?: PumpRunMeta[];
  pumpVisible?: Record<string, boolean>;
}) {
  if (pts.length < 2 && tStart == null) {
    return <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">{emptyHint}</div>;
  }
  const W = 600, H = 150, P = 4;
  const vals = pts.map((p) => p[1]).filter(Number.isFinite);
  const bandLo = sp != null && hyst != null ? sp - hyst : null;
  const bandHi = sp != null && hyst != null ? sp + hyst : null;
  let lo = vals.length ? Math.min(...vals) : (sp ?? 0);
  let hi = vals.length ? Math.max(...vals) : (sp ?? 100);
  if (bandLo != null) lo = Math.min(lo, bandLo);
  if (bandHi != null) hi = Math.max(hi, bandHi);
  if (sp != null) { lo = Math.min(lo, sp); hi = Math.max(hi, sp); }
  const pad = Math.max(2, (hi - lo) * 0.12 || 2);
  lo -= pad; hi += pad;
  const t0 = tStart ?? pts[0]?.[0] ?? Date.now() - 3600_000;
  const t1 = tEnd ?? pts[pts.length - 1]?.[0] ?? Date.now();
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => P + ((t - t0) / span) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 2 * P);
  const line = buildSpBandPath(pts, x, y, gapMs);
  const band = (a: number, b: number, fill: string) => {
    const ya = y(Math.min(hi, Math.max(lo, b)));
    const yb = y(Math.min(hi, Math.max(lo, a)));
    return <rect x={0} y={ya} width={W} height={Math.max(0, yb - ya)} fill={fill} />;
  };

  const pumps = (pumpMeta ?? []).filter((p) => pumpVisible?.[p.id] !== false);
  const laneH = 7;
  const laneGap = 2;
  const lanesTop = H - P - Math.max(1, pumps.length) * (laneH + laneGap);
  const minVisualMs = Math.max(5_000, span * (10 / W));
  const pumpRects: ReactNode[] = [];
  if (pumps.length && pumpIntervals?.length) {
    const laneOf = Object.fromEntries(pumps.map((p, i) => [p.id, i]));
    const meta = Object.fromEntries(pumps.map((p) => [p.id, p]));
    for (const iv of pumpIntervals) {
      if (pumpVisible?.[iv.pump] === false) continue;
      const m = meta[iv.pump];
      if (!m) continue;
      const lane = laneOf[iv.pump] ?? 0;
      let x1 = Math.max(t0, iv.startMs);
      let x2 = Math.min(t1, iv.endMs);
      if (x2 < x1) continue;
      if (x2 - x1 < minVisualMs) {
        const mid = (iv.startMs + iv.endMs) / 2;
        x1 = Math.max(t0, mid - minVisualMs / 2);
        x2 = Math.min(t1, mid + minVisualMs / 2);
      }
      const px = x(x1);
      const pw = Math.max(1, x(x2) - px);
      const py = lanesTop + lane * (laneH + laneGap);
      pumpRects.push(
        <rect
          key={`pr-${iv.pump}-${iv.startMs}`}
          x={px}
          y={py}
          width={pw}
          height={laneH}
          fill={m.color}
          fillOpacity={0.55}
          stroke={m.color}
          strokeOpacity={0.35}
          strokeWidth={0.5}
        >
          <title>{m.label}</title>
        </rect>,
      );
    }
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" preserveAspectRatio="none" data-testid={testid}>
        {bandLo != null && bandHi != null && band(bandLo, bandHi, "rgba(56,189,248,0.12)")}
        {sp != null && <line x1={0} x2={W} y1={y(sp)} y2={y(sp)} stroke="#a1a1aa" strokeDasharray="4 4" strokeWidth={1} />}
        {min != null && min > lo && min < hi && <line x1={0} x2={W} y1={y(min)} y2={y(min)} stroke="#ef4444" strokeDasharray="2 3" strokeWidth={1} />}
        {max != null && max > lo && max < hi && <line x1={0} x2={W} y1={y(max)} y2={y(max)} stroke="#ef4444" strokeDasharray="2 3" strokeWidth={1} />}
        {pumpRects}
        {line ? <path d={line} fill="none" stroke="#38bdf8" strokeWidth={2} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{new Date(t0).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" })}</span>
        <span>
          <span className="text-sky-400">━</span> pinta · <span>┅</span> SP
          {hyst != null ? <> · <span className="text-sky-300/80">▮</span> SP±hyst</> : null}
          {unit ? ` (${unit})` : ""}
        </span>
        <span>{new Date(t1).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}

export const dfHm = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("fi-FI", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
export const dfYn = (b?: boolean) => (b == null ? "—" : b ? "ON" : "OFF");
