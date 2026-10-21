import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AXIS_TICK, BUCKET_OPTIONS, LEGEND_PROPS, resolveSeries, timeTickLabel, timeTicks, useSeriesDefaults } from "@/lib/seriesStyle";
import { useWidth } from "@/lib/useWidth";
import { renderSeriesChildren, SeriesStyleEditor } from "@/components/trends/SeriesStyleEditor";
import { AreaChart, CartesianGrid, Legend, LineChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import {
  BarChart3,
  CopyPlus,
  Eye,
  EyeOff,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  deleteTrendPreset,
  getDataloggerVariables,
  getTrendPresets,
  getTrendSeries,
  getTrendVariables,
  saveTrendPreset,
  updateDataloggerVariable,
  type DataloggerVariable,
  type DataloggerVariablePatch,
  type TrendBucket,
  type TrendLayout,
  type TrendPoint,
  type TrendPreset,
  type TrendVariable,
  type TrendWidgetConfig,
  type WorkspaceKey,
} from "@/lib/apiClient";

export const Route = createFileRoute("/trends")({
  head: () => ({ meta: [{ title: "Trends - Myko Valvomo" }] }),
  component: () => <TrendsPage workspace="myko" />,
});

const workspaceLabels: Record<WorkspaceKey, string> = {
  myko: "Myko",
  plants: "Plants",
};

const rangeOptions = [
  { value: "1h", label: "1 h" },
  { value: "6h", label: "6 h" },
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
  { value: "custom", label: "Custom" },
] as const;

const selectCls =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring";

const seriesColors = [
  "var(--primary)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-2)",
  "var(--status-harvested)",
];

type LoadedSeries = {
  variable: TrendVariable;
  points: TrendPoint[];
};

export function TrendsPage({ workspace }: { workspace: WorkspaceKey }) {
  const [variables, setVariables] = useState<TrendVariable[]>([]);
  const [dataloggerVariables, setDataloggerVariables] = useState<DataloggerVariable[]>([]);
  const [presets, setPresets] = useState<TrendPreset[]>([]);
  const [widgets, setWidgets] = useState<TrendWidgetConfig[]>([]);
  const [viewName, setViewName] = useState("New trend view");
  const [currentPresetId, setCurrentPresetId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const [nextVariables, nextPresets, nextDataloggerVariables] = await Promise.all([
        getTrendVariables(),
        getTrendPresets(workspace),
        getDataloggerVariables(),
      ]);
      setVariables(nextVariables);
      setPresets(nextPresets);
      setDataloggerVariables(nextDataloggerVariables);
      setWidgets((current) =>
        current.length > 0
          ? current.map((widget) => normalizeWidget(widget, nextVariables[0]?.id))
          : [createWidget(nextVariables[0]?.id)],
      );
      setStatus("ok");
    } catch (err) {
      setStatus("error");
      setError((err as Error).message);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const variableMap = useMemo(
    () => new Map(variables.map((variable) => [variable.id, variable])),
    [variables],
  );

  const updateWidget = (id: string, patch: Partial<TrendWidgetConfig>) => {
    setWidgets((current) =>
      current.map((widget) => (widget.id === id ? { ...widget, ...patch } : widget)),
    );
  };

  const addWidget = () => {
    setWidgets((current) => [...current, createWidget(variables[0]?.id)]);
  };

  const removeWidget = (id: string) => {
    setWidgets((current) => current.filter((widget) => widget.id !== id));
  };

  const loadPreset = (preset: TrendPreset) => {
    setCurrentPresetId(preset.id);
    setViewName(preset.name);
    setWidgets(
      preset.layout.widgets.length > 0
        ? preset.layout.widgets.map((widget) => normalizeWidget(widget, variables[0]?.id))
        : [createWidget(variables[0]?.id)],
    );
  };

  const newView = () => {
    setCurrentPresetId(null);
    setViewName("New trend view");
    setWidgets([createWidget(variables[0]?.id)]);
  };

  const saveView = async (asCopy = false) => {
    if (!viewName.trim()) return toast.error("Name is required");
    if (widgets.length === 0) return toast.error("Add at least one trend view");

    const id = asCopy || !currentPresetId ? `trend-${Date.now()}` : currentPresetId;
    setSaving(true);
    try {
      const layout: TrendLayout = {
        widgets: widgets.map((widget) => normalizeWidget(widget, variables[0]?.id)),
      };
      const saved = await saveTrendPreset({
        id,
        viewKey: workspace,
        name: viewName.trim(),
        layout,
      });
      setCurrentPresetId(saved.id);
      setViewName(saved.name);
      const nextPresets = await getTrendPresets(workspace);
      setPresets(nextPresets);
      toast.success("Trend view saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteCurrent = async () => {
    if (!currentPresetId) return;
    if (!confirm(`Delete "${viewName}"?`)) return;
    setSaving(true);
    try {
      await deleteTrendPreset(currentPresetId);
      const nextPresets = await getTrendPresets(workspace);
      setPresets(nextPresets);
      newView();
      toast.success("Trend preset deleted");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveDataloggerVariable = async (
    variable: DataloggerVariable,
    patch: DataloggerVariablePatch,
  ) => {
    try {
      const saved = await updateDataloggerVariable(variable.sourceId, variable.variableKey, patch);
      setDataloggerVariables((current) =>
        current.map((item) =>
          item.sourceId === saved.sourceId && item.variableKey === saved.variableKey ? saved : item,
        ),
      );
      setVariables(await getTrendVariables());
      toast.success("Variable settings saved");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-mono flex items-center gap-2">
          <TrendingUp className="h-4 w-4" /> {workspaceLabels[workspace]} trends
        </h1>
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
        <div className="ml-auto text-[10px] font-mono text-muted-foreground">
          API: {status === "ok" ? "connected" : status}
          {error ? ` - ${error}` : ""}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr] gap-4 items-start">
        <Card className="p-4 bg-card border-border space-y-4">
          <div className="space-y-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Current view
            </div>
            <Input
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              className="font-mono text-xs"
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                onClick={() => void saveView(false)}
                disabled={saving || status === "error"}
              >
                <Save className="h-3 w-3 mr-1" /> Save
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void saveView(true)}
                disabled={saving || status === "error"}
              >
                <CopyPlus className="h-3 w-3 mr-1" /> Copy
              </Button>
              <Button size="sm" variant="outline" onClick={newView} disabled={saving}>
                New
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void deleteCurrent()}
                disabled={saving || !currentPresetId}
              >
                <Trash2 className="h-3 w-3 mr-1" /> Delete
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Saved presets
            </div>
            <div className="space-y-1">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => loadPreset(preset)}
                  className={`w-full rounded border px-2 py-2 text-left text-xs transition-colors ${
                    preset.id === currentPresetId
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-secondary/20 hover:bg-secondary"
                  }`}
                >
                  <div className="font-mono truncate">{preset.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {preset.layout.widgets.length} views
                  </div>
                </button>
              ))}
              {presets.length === 0 && (
                <div className="text-xs text-muted-foreground italic">No saved presets yet.</div>
              )}
            </div>
          </div>

          <div className="rounded border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
            Variables are discovered from MariaDB environment readings. Each saved preset stores the
            whole page layout.
          </div>
        </Card>

        <div className="space-y-4 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={addWidget} disabled={variables.length === 0}>
              <BarChart3 className="h-4 w-4 mr-2" /> Add trend view
            </Button>
            <div className="text-xs text-muted-foreground">
              {variables.length} DB variables available
            </div>
          </div>

          <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
            {widgets.map((widget) => (
              <TrendWidget
                key={widget.id}
                widget={widget}
                variables={variables}
                variableMap={variableMap}
                onChange={(patch) => updateWidget(widget.id, patch)}
                onRemove={() => removeWidget(widget.id)}
              />
            ))}
          </div>
        </div>
      </div>

      <DataloggerVariablesPanel variables={dataloggerVariables} onSave={saveDataloggerVariable} />
    </div>
  );
}

function DataloggerVariablesPanel({
  variables,
  onSave,
}: {
  variables: DataloggerVariable[];
  onSave: (variable: DataloggerVariable, patch: DataloggerVariablePatch) => void | Promise<void>;
}) {
  return (
    <Card className="p-4 bg-card border-border space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
          Datalogger variables
        </h2>
        <div className="ml-auto text-[10px] font-mono text-muted-foreground">
          {variables.filter((variable) => variable.visible).length} visible / {variables.length}{" "}
          total
        </div>
      </div>
      <datalist id="datalogger-prefixes">
        <option value="Sensor" />
        <option value="Setpoint" />
        <option value="Alarm" />
        <option value="Status" />
        <option value="Raw" />
      </datalist>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-xs">
          <thead className="bg-secondary/50 text-muted-foreground uppercase font-mono text-[10px]">
            <tr>
              <th className="p-2 text-left w-16">Index</th>
              <th className="p-2 text-left">Name</th>
              <th className="p-2 text-left w-40">Prefix</th>
              <th className="p-2 text-left w-28">Multiplier</th>
              <th className="p-2 text-left w-24">Unit</th>
              <th className="p-2 text-left w-28">Visible</th>
              <th className="p-2 text-right w-24">Save</th>
            </tr>
          </thead>
          <tbody>
            {variables.map((variable) => (
              <DataloggerVariableRow
                key={`${variable.sourceId}-${variable.variableKey}`}
                variable={variable}
                onSave={onSave}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DataloggerVariableRow({
  variable,
  onSave,
}: {
  variable: DataloggerVariable;
  onSave: (variable: DataloggerVariable, patch: DataloggerVariablePatch) => void | Promise<void>;
}) {
  const [prefix, setPrefix] = useState(variable.prefix);
  const [scale, setScale] = useState(String(variable.scale));
  const [unit, setUnit] = useState(variable.unit);
  const [visible, setVisible] = useState(variable.visible);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPrefix(variable.prefix);
    setScale(String(variable.scale));
    setUnit(variable.unit);
    setVisible(variable.visible);
  }, [variable]);

  const dirty =
    prefix !== variable.prefix ||
    Number(scale) !== variable.scale ||
    unit !== variable.unit ||
    visible !== variable.visible;

  const submit = async () => {
    const nextScale = Number(scale);
    if (!Number.isFinite(nextScale)) return toast.error("Multiplier must be numeric");
    setSaving(true);
    try {
      await onSave(variable, {
        prefix,
        scale: nextScale,
        unit,
        visible,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-t border-border">
      <td className="p-2 font-mono text-muted-foreground">{variable.position}</td>
      <td className="p-2">
        <div className="font-mono text-foreground">{variable.name}</div>
        <div className="text-[10px] text-muted-foreground">{variable.variableKey}</div>
      </td>
      <td className="p-2">
        <Input
          value={prefix}
          onChange={(event) => setPrefix(event.target.value)}
          className="h-8 font-mono text-xs"
          list="datalogger-prefixes"
        />
      </td>
      <td className="p-2">
        <Input
          value={scale}
          onChange={(event) => setScale(event.target.value)}
          className="h-8 font-mono text-xs"
          inputMode="decimal"
        />
      </td>
      <td className="p-2">
        <Input
          value={unit}
          onChange={(event) => setUnit(event.target.value)}
          className="h-8 font-mono text-xs"
        />
      </td>
      <td className="p-2">
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className={`inline-flex h-8 items-center gap-2 rounded border px-2 font-mono text-[10px] uppercase ${
            visible
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border bg-secondary/30 text-muted-foreground"
          }`}
        >
          {visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          {visible ? "Trend" : "Hidden"}
        </button>
      </td>
      <td className="p-2 text-right">
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || saving}
          onClick={() => void submit()}
        >
          <Save className="h-3 w-3 mr-1" />
          Save
        </Button>
      </td>
    </tr>
  );
}

function TrendWidget({
  widget,
  variables,
  variableMap,
  onChange,
  onRemove,
}: {
  widget: TrendWidgetConfig;
  variables: TrendVariable[];
  variableMap: Map<string, TrendVariable>;
  onChange: (patch: Partial<TrendWidgetConfig>) => void;
  onRemove: () => void;
}) {
  const [series, setSeries] = useState<LoadedSeries[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [error, setError] = useState("");
  const selectedVariableIds = getWidgetVariableIds(widget);
  const selectedVariableKey = selectedVariableIds.join("|");
  const selectedVariables = selectedVariableIds
    .map((id) => variableMap.get(id))
    .filter((variable): variable is TrendVariable => Boolean(variable));

  const range = useMemo(
    () => resolveRange(widget.range, widget.from, widget.to),
    [widget.range, widget.from, widget.to],
  );

  useEffect(() => {
    let cancelled = false;
    const loadSeries = async () => {
      const variablesToLoad = selectedVariableKey
        .split("|")
        .filter(Boolean)
        .map((id) => variableMap.get(id))
        .filter((variable): variable is TrendVariable => Boolean(variable));
      if (variablesToLoad.length === 0) {
        setSeries([]);
        return;
      }
      setStatus("loading");
      setError("");
      try {
        const nextSeries = await Promise.all(
          variablesToLoad.map(async (variable) => ({
            variable,
            points: await getTrendSeries({
              variableId: variable.id,
              from: range.from,
              to: range.to,
              bucket: widget.bucket,
            }),
          })),
        );
        if (!cancelled) {
          setSeries(nextSeries);
          setStatus("ok");
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setError((err as Error).message);
        }
      }
    };
    void loadSeries();
    return () => {
      cancelled = true;
    };
  }, [selectedVariableKey, variableMap, widget.bucket, range.from, range.to]);

  const chartData = buildMultiSeriesData(series, widget.range);
  const { defaults } = useSeriesDefaults();
  const resolved = resolveSeries(series.map((x) => x.variable.id), variableMap, widget, defaults);
  const selectedResolved = resolveSeries(selectedVariableIds, variableMap, widget, defaults);
  const [chartRef, chartWidth] = useWidth<HTMLDivElement>();
  const ticks =
    chartData.length > 1
      ? timeTicks(Number(chartData[0].ts), Number(chartData[chartData.length - 1].ts), chartWidth - 110)
      : [];
  const totalPoints = series.reduce((sum, item) => sum + item.points.length, 0);

  const toggleVariable = (variableId: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...selectedVariableIds, variableId]))
      : selectedVariableIds.filter((id) => id !== variableId);
    onChange({ variableIds: next, variableId: next[0] });
  };

  return (
    <Card className="p-4 bg-card border-border space-y-3 min-w-0">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_110px_95px_44px] gap-2 items-end">
        <Field label="Title">
          <Input
            value={widget.title}
            onChange={(event) => onChange({ title: event.target.value })}
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Range">
          <select
            value={widget.range}
            onChange={(event) =>
              onChange({ range: event.target.value as TrendWidgetConfig["range"] })
            }
            className={selectCls}
          >
            {rangeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bucket">
          <select
            value={widget.bucket}
            onChange={(event) => onChange({ bucket: event.target.value as TrendBucket })}
            className={selectCls}
          >
            {BUCKET_OPTIONS.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </Field>
        <Button variant="outline" size="icon" onClick={onRemove} aria-label="Remove trend view">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="rounded border border-border bg-secondary/20 p-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Variables
          </div>
          <div className="text-[10px] font-mono text-muted-foreground">
            {selectedVariables.length} selected
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
          {variables.map((item, index) => {
            const selectedIndex = selectedVariableIds.indexOf(item.id);
            const colorIndex = selectedIndex >= 0 ? selectedIndex : index;
            return (
              <label
                key={item.id}
                className="flex min-w-0 items-center gap-2 rounded border border-border bg-background/40 px-2 py-1.5 text-xs"
              >
                <input
                  type="checkbox"
                  checked={selectedIndex >= 0}
                  onChange={(event) => toggleVariable(item.id, event.target.checked)}
                />
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                  style={{
                    background:
                      selectedResolved[selectedIndex]?.color ?? seriesColors[colorIndex % seriesColors.length],
                  }}
                />
                <span className="truncate font-mono">{item.label}</span>
              </label>
            );
          })}
        </div>
      </div>

      {selectedVariableIds.length > 0 && (
        <div className="rounded border border-border bg-secondary/20 p-2">
          <SeriesStyleEditor
            ids={selectedVariableIds}
            variables={variables}
            styling={widget}
            onChange={(st) => onChange({ series: st.series, axes: st.axes })}
          />
        </div>
      )}

      {widget.range === "custom" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Field label="From">
            <Input
              type="datetime-local"
              value={toLocalInput(widget.from ?? range.from)}
              onChange={(event) => onChange({ from: localInputToIso(event.target.value) })}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="To">
            <Input
              type="datetime-local"
              value={toLocalInput(widget.to ?? range.to)}
              onChange={(event) => onChange({ to: localInputToIso(event.target.value) })}
              className="font-mono text-xs"
            />
          </Field>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-mono text-foreground">
          {selectedVariables.length > 0 ? `${selectedVariables.length} variables` : "No variables"}
        </span>
        {totalPoints > 0 && <span>{totalPoints} points</span>}
        <button
          type="button"
          onClick={() => onChange({ chartType: widget.chartType === "line" ? "area" : "line" })}
          className="rounded border border-border px-2 py-1 font-mono text-[10px] uppercase hover:bg-secondary"
        >
          {widget.chartType}
        </button>
        <span className="ml-auto font-mono text-[10px]">
          {status === "loading" ? "Loading" : status === "error" ? error : ""}
        </span>
      </div>

      <div ref={chartRef} className="h-[300px] w-full min-w-0">
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            {widget.chartType === "area" ? (
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={ticks} tickFormatter={(ts: number) => timeTickLabel(ts, ticks)} stroke="var(--muted-foreground)" tick={AXIS_TICK} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--foreground)" }} labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("fi-FI", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })} />
                <Legend {...LEGEND_PROPS} />
                {renderSeriesChildren(resolved, widget, (_id, i) => seriesKey(i), {
                  kind: "area", strokeWidth: 2, axisStroke: "var(--muted-foreground)",
                  dots: (i) => (series[i]?.points.length ?? 0) <= 24,
                })}
              </AreaChart>
            ) : (
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={ticks} tickFormatter={(ts: number) => timeTickLabel(ts, ticks)} stroke="var(--muted-foreground)" tick={AXIS_TICK} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--foreground)" }} labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("fi-FI", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })} />
                <Legend {...LEGEND_PROPS} />
                {renderSeriesChildren(resolved, widget, (_id, i) => seriesKey(i), {
                  strokeWidth: 2, axisStroke: "var(--muted-foreground)",
                  dots: (i) => (series[i]?.points.length ?? 0) <= 24,
                })}
              </LineChart>
            )}
          </ResponsiveContainer>
        ) : (
          <div className="h-full rounded border border-dashed border-border bg-secondary/20 flex items-center justify-center text-xs text-muted-foreground">
            {status === "loading" ? "Loading trend data..." : "No samples for this selection."}
          </div>
        )}
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 text-xs">
      <span className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function getWidgetVariableIds(widget: TrendWidgetConfig) {
  if (Array.isArray(widget.variableIds) && widget.variableIds.length > 0) {
    return widget.variableIds;
  }
  return widget.variableId ? [widget.variableId] : [];
}

function normalizeWidget(widget: TrendWidgetConfig, fallbackVariableId = ""): TrendWidgetConfig {
  const variableIds = getWidgetVariableIds(widget);
  const nextVariableIds =
    variableIds.length > 0 ? variableIds : fallbackVariableId ? [fallbackVariableId] : [];
  return {
    ...widget,
    variableId: nextVariableIds[0],
    variableIds: nextVariableIds,
  };
}

function buildMultiSeriesData(series: LoadedSeries[], range: TrendWidgetConfig["range"]) {
  const rows = new Map<string, Record<string, string | number | undefined>>();

  series.forEach((item, index) => {
    for (const point of item.points) {
      const current = rows.get(point.timestamp) ?? {
        timestamp: point.timestamp,
        ts: new Date(point.timestamp).getTime(),
        label: formatTick(point.timestamp, range),
      };
      current[seriesKey(index)] = point.value;
      rows.set(point.timestamp, current);
    }
  });

  return Array.from(rows.values()).sort((a, b) =>
    String(a.timestamp).localeCompare(String(b.timestamp)),
  );
}

function seriesKey(index: number) {
  return `value${index}`;
}

function createWidget(variableId = ""): TrendWidgetConfig {
  return {
    id: `widget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Trend",
    variableId,
    variableIds: variableId ? [variableId] : [],
    range: "24h",
    bucket: "10m",
    chartType: "line",
  };
}

function resolveRange(range: TrendWidgetConfig["range"], customFrom?: string, customTo?: string) {
  const to = range === "custom" && customTo ? new Date(customTo) : new Date();
  const from =
    range === "custom" && customFrom
      ? new Date(customFrom)
      : new Date(to.getTime() - rangeMs(range));
  return { from: from.toISOString(), to: to.toISOString() };
}

function rangeMs(range: TrendWidgetConfig["range"]) {
  if (range === "1h") return 60 * 60 * 1000;
  if (range === "6h") return 6 * 60 * 60 * 1000;
  if (range === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (range === "30d") return 30 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function formatTick(iso: string, range: TrendWidgetConfig["range"]) {
  const date = new Date(iso);
  if (range === "30d" || range === "7d") {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function toLocalInput(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function localInputToIso(value: string) {
  return new Date(value).toISOString();
}

const tooltipStyle = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--foreground)",
} satisfies React.CSSProperties;
