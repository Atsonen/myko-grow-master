// Shared faceplate building blocks for device detail dialogs (EC-style).
import type { ReactNode } from "react";

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

/** Line trend with optional SP ± hyst band (and optional absolute min/max dashed lines). */
export function DfSpBandTrend({
  pts, sp, hyst, min, max, unit = "%", testid = "df-trend", emptyHint = "Trendi kertyy (1 min näytteet, ~24 h)…",
}: {
  pts: [number, number][];
  sp?: number | null;
  hyst?: number | null;
  min?: number | null;
  max?: number | null;
  unit?: string;
  testid?: string;
  emptyHint?: string;
}) {
  if (pts.length < 2) {
    return <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">{emptyHint}</div>;
  }
  const W = 600, H = 150, P = 4;
  const vals = pts.map((p) => p[1]);
  const bandLo = sp != null && hyst != null ? sp - hyst : null;
  const bandHi = sp != null && hyst != null ? sp + hyst : null;
  let lo = Math.min(...vals, ...(bandLo != null ? [bandLo] : []), ...(sp != null ? [sp] : []));
  let hi = Math.max(...vals, ...(bandHi != null ? [bandHi] : []), ...(sp != null ? [sp] : []));
  const pad = Math.max(2, (hi - lo) * 0.12 || 2);
  lo -= pad; hi += pad;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const band = (a: number, b: number, fill: string) => {
    const ya = y(Math.min(hi, Math.max(lo, b)));
    const yb = y(Math.min(hi, Math.max(lo, a)));
    return <rect x={0} y={ya} width={W} height={Math.max(0, yb - ya)} fill={fill} />;
  };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" preserveAspectRatio="none" data-testid={testid}>
        {bandLo != null && bandHi != null && band(bandLo, bandHi, "rgba(56,189,248,0.12)")}
        {sp != null && <line x1={0} x2={W} y1={y(sp)} y2={y(sp)} stroke="#a1a1aa" strokeDasharray="4 4" strokeWidth={1} />}
        {min != null && min > lo && min < hi && <line x1={0} x2={W} y1={y(min)} y2={y(min)} stroke="#ef4444" strokeDasharray="2 3" strokeWidth={1} />}
        {max != null && max > lo && max < hi && <line x1={0} x2={W} y1={y(max)} y2={y(max)} stroke="#ef4444" strokeDasharray="2 3" strokeWidth={1} />}
        <path d={line} fill="none" stroke="#38bdf8" strokeWidth={2} vectorEffect="non-scaling-stroke" />
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
