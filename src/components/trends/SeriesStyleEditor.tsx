import { useState } from "react";
import { Area, Line, YAxis } from "recharts";
import type { TrendVariable } from "@/lib/apiClient";
import {
  axisDomain,
  axisLabel,
  resolveSeries,
  useSeriesDefaults,
  type AxisRange,
  type ResolvedSeries,
  type SeriesStyle,
  type TrendStyling,
} from "@/lib/seriesStyle";

const inputCls = "h-7 rounded border border-input bg-background px-1.5 text-xs font-mono";

function numOrNull(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Per-series display name / color / axis + per-axis min/max editor (widget-level overrides). */
export function SeriesStyleEditor({
  ids,
  variables,
  styling,
  onChange,
}: {
  ids: string[];
  variables: TrendVariable[];
  styling: TrendStyling | undefined;
  onChange: (next: TrendStyling) => void;
}) {
  const { defaults, save } = useSeriesDefaults();
  const [savedId, setSavedId] = useState("");
  const resolved = resolveSeries(ids, variables, styling, defaults);
  const series = styling?.series ?? {};
  const axes = styling?.axes ?? {};
  const setSeries = (id: string, patch: Partial<SeriesStyle>) => {
    const cur = { ...(series[id] ?? {}), ...patch };
    for (const k of Object.keys(cur) as (keyof SeriesStyle)[]) if (!cur[k] || cur[k] === "auto") delete cur[k];
    const next = { ...series, [id]: cur };
    if (Object.keys(cur).length === 0) delete next[id];
    onChange({ ...styling, series: next });
  };
  const setAxis = (side: "left" | "right", patch: AxisRange) =>
    onChange({ ...styling, axes: { ...axes, [side]: { ...(axes[side] ?? {}), ...patch } } });

  if (ids.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="series-style-editor">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Series display</div>
      {resolved.map((r) => {
        const v = variables.find((x) => x.id === r.id);
        const own = series[r.id] ?? {};
        return (
          <div key={r.id} className="grid grid-cols-[28px_1fr_96px_auto] items-center gap-1.5" data-series={r.id}>
            <input
              type="color"
              aria-label={`Color ${v?.label ?? r.id}`}
              value={r.color}
              onChange={(e) => setSeries(r.id, { color: e.target.value })}
              className="h-7 w-7 cursor-pointer rounded border border-input bg-transparent p-0"
            />
            <input
              aria-label={`Display name ${v?.label ?? r.id}`}
              className={inputCls + " min-w-0"}
              placeholder={defaults[r.id]?.name || v?.label || r.id}
              title={v?.label}
              value={own.name ?? ""}
              onChange={(e) => setSeries(r.id, { name: e.target.value })}
            />
            <select
              aria-label={`Axis ${v?.label ?? r.id}`}
              className={inputCls}
              value={own.axis ?? "auto"}
              onChange={(e) => setSeries(r.id, { axis: e.target.value as SeriesStyle["axis"] })}
            >
              <option value="auto">auto ({r.axis === "left" ? "L" : "R"})</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </select>
            <button
              type="button"
              className="rounded border border-border px-1.5 py-1 text-[10px] font-mono uppercase hover:bg-secondary"
              title="Save this name/color/axis as the default for this variable in all trend views"
              onClick={async () => {
                await save(r.id, {
                  name: own.name || defaults[r.id]?.name,
                  color: r.color,
                  axis: own.axis === "left" || own.axis === "right" ? own.axis : defaults[r.id]?.axis,
                });
                setSavedId(r.id);
                window.setTimeout(() => setSavedId(""), 1500);
              }}
            >
              {savedId === r.id ? "saved" : "default"}
            </button>
          </div>
        );
      })}
      <div className="grid grid-cols-2 gap-2 pt-1">
        {(["left", "right"] as const).map((side) => (
          <div key={side} className="space-y-1">
            <div className="text-[10px] font-mono uppercase text-muted-foreground">
              {side} axis{axisLabel(resolved, side) ? ` (${axisLabel(resolved, side)})` : ""}
            </div>
            <div className="flex gap-1">
              {(["min", "max"] as const).map((k) => (
                <input
                  key={k}
                  aria-label={`${side} axis ${k}`}
                  className={inputCls + " w-full"}
                  placeholder={`${k} auto`}
                  inputMode="decimal"
                  defaultValue={axes[side]?.[k] ?? ""}
                  onBlur={(e) => setAxis(side, { [k]: numOrNull(e.target.value) })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Recharts children: Y axes (right only when used) + one Line/Area per series. */
export function renderSeriesChildren(
  resolved: ResolvedSeries[],
  styling: TrendStyling | undefined,
  dataKey: (id: string, index: number) => string,
  opts: { kind?: "line" | "area"; strokeWidth?: number; dots?: (index: number) => boolean; axisStroke?: string; axisWidth?: number } = {},
) {
  const hasRight = resolved.some((s) => s.axis === "right");
  const hasLeft = resolved.some((s) => s.axis === "left") || !hasRight;
  const tick = { fontSize: 10 };
  const lDom = axisDomain(styling?.axes?.left);
  const rDom = axisDomain(styling?.axes?.right);
  const out = [];
  if (hasLeft)
    out.push(
      <YAxis key="ax-l" yAxisId="left" orientation="left" tick={tick} domain={lDom} width={opts.axisWidth ?? 42}
        stroke={opts.axisStroke} allowDataOverflow={lDom.some((d) => d !== "auto")} />,
    );
  if (hasRight)
    out.push(
      <YAxis key="ax-r" yAxisId="right" orientation="right" tick={tick} domain={rDom} width={opts.axisWidth ?? 42}
        stroke={opts.axisStroke} allowDataOverflow={rDom.some((d) => d !== "auto")} />,
    );
  resolved.forEach((s, i) => {
    const common = {
      key: s.id,
      yAxisId: s.axis,
      dataKey: dataKey(s.id, i),
      name: s.name,
      stroke: s.color,
      dot: opts.dots?.(i) ? { r: 2 } : false,
      connectNulls: true,
      strokeWidth: opts.strokeWidth ?? 1.5,
      isAnimationActive: false,
      unit: s.unit ? ` ${s.unit}` : undefined,
    } as const;
    out.push(
      opts.kind === "area" ? (
        <Area {...common} type="monotone" fill={s.color} fillOpacity={0.12} />
      ) : (
        <Line {...common} type="monotone" />
      ),
    );
  });
  return out;
}
