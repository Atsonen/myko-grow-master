import { useEffect, useMemo, useState } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { toast } from "sonner";
import { Gauge, GripVertical, LayoutGrid, Pencil, Plus, RefreshCw, RotateCcw, Save, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getDashboardLayout, resetDashboardLayout, saveDashboardLayout } from "@/lib/apiClient";
import { DashboardDataProvider, useDashboardData } from "./DashboardData";
import { WidgetBody, defaultTitle } from "./widgets";
import { WidgetSettingsDialog } from "./WidgetSettings";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  DEFAULT_LAYOUT,
  TREND_RANGES,
  WIDGET_META,
  migrateLegacyPanelWidget,
  newWidgetId,
  type DashboardLayout,
  type DashboardWidget,
  type WidgetConfigMap,
  type WidgetType,
} from "./types";
import type { ReactNode } from "react";

const ResponsiveGrid = WidthProvider(GridLayout);
/** 24-column grid (layout v2). v1 layouts were 12 columns: x/w are doubled on load. WIDGET_META sizes are in 12-col units. */
const COLS = 24;
const MINW_24: Partial<Record<WidgetType, number>> = { measurementPoint: 2 };
const ROW_HEIGHT = 44;

export type DashboardGridProps = {
  /** dashboard_layouts id; omit for the main Myko dashboard. */
  layoutId?: string;
  defaultLayout?: DashboardLayout;
  title?: string;
  /** Optional status line under/beside the title (e.g. process poll age). */
  headerExtra?: ReactNode;
  titleIcon?: "grid" | "gauge";
};

function sanitize(layout: DashboardLayout | null | undefined, fallback: DashboardLayout): DashboardLayout {
  if (!layout || !Array.isArray(layout.widgets)) return sanitize(fallback, fallback);
  const k = layout.version === 2 ? 1 : 2;
  const widgets: DashboardWidget[] = [];
  for (const raw of layout.widgets) {
    if (!raw) continue;
    let w: DashboardWidget | null = null;
    if (typeof raw === "object" && (raw as DashboardWidget).type in WIDGET_META) {
      w = { ...(raw as DashboardWidget), config: (raw as DashboardWidget).config ?? {} };
    } else {
      w = migrateLegacyPanelWidget(raw as unknown as Record<string, unknown>);
    }
    if (!w || !(w.type in WIDGET_META)) continue;
    widgets.push({ ...w, x: w.x * k, w: w.w * k, config: w.config ?? {} });
  }
  if (widgets.length === 0) return sanitize(fallback, fallback);
  return { version: 2, widgets };
}

export function CustomDashboard(props: DashboardGridProps = {}) {
  // react-grid-layout measures the DOM; render only on the client to avoid SSR mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <DashboardDataProvider>
      {mounted ? <DashboardInner {...props} /> : <div className="p-4 text-xs text-muted-foreground font-mono">Loading dashboard…</div>}
    </DashboardDataProvider>
  );
}

/** Phone height per widget in the stacked view (desktop grid units are ignored there). */
function mobileHeight(w: DashboardWidget): number | undefined {
  switch (w.type) {
    case "trend":
    case "unitCurve":
      return 300;
    case "sensorLatest":
      return 150;
    case "weather":
    case "spaceWeather":
      return 380;
    case "statusBits":
    case "measurementPoint":
    case "alarmList":
    case "note":
    case "fertDose":
      return undefined; // natural height
    case "processDiagram":
      return 520;
    case "circSequence":
      return 360;
    default:
      return Math.min(420, Math.max(200, w.h * ROW_HEIGHT));
  }
}

function DashboardInner({ layoutId, defaultLayout = DEFAULT_LAYOUT, title = "Dashboard", headerExtra, titleIcon = "grid" }: DashboardGridProps) {
  const data = useDashboardData();
  const fallback = defaultLayout;
  // < 768 px: read-only single column in saved desktop order; the saved grid is never touched here.
  const isMobile = useIsMobile();
  const [saved, setSaved] = useState<DashboardLayout | null>(null);
  const [layout, setLayout] = useState<DashboardLayout>(() => sanitize(fallback, fallback));
  const [isDefault, setIsDefault] = useState(true);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(false);
  const [settingsFor, setSettingsFor] = useState<DashboardWidget | null>(null);

  useEffect(() => {
    getDashboardLayout<DashboardLayout>(layoutId)
      .then((res) => {
        const l = sanitize(res.layout, fallback);
        setSaved(l);
        setLayout(l);
        setIsDefault(!res.layout);
      })
      .catch((e) => toast.error(`Layout load failed: ${(e as Error).message}`));
  }, [layoutId, fallback]);

  const labelFor = (id: string) => data.variables.find((v) => v.id === id)?.label;

  const gridItems: Layout[] = useMemo(
    () =>
      layout.widgets.map((w) => ({
        i: w.id,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        minW: MINW_24[w.type] ?? WIDGET_META[w.type].minW * 2,
        minH: WIDGET_META[w.type].minH,
      })),
    [layout],
  );

  const onLayoutChange = (items: Layout[]) => {
    if (!editing) return;
    const pos = new Map(items.map((it) => [it.i, it]));
    let changed = false;
    const widgets = layout.widgets.map((w) => {
      const p = pos.get(w.id);
      if (!p || (p.x === w.x && p.y === w.y && p.w === w.w && p.h === w.h)) return w;
      changed = true;
      return { ...w, x: p.x, y: p.y, w: p.w, h: p.h };
    });
    if (changed) {
      setLayout({ ...layout, widgets });
      setDirty(true);
    }
  };

  const addWidget = (type: WidgetType) => {
    const meta = WIDGET_META[type];
    const maxY = layout.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    const w: DashboardWidget = { id: newWidgetId(), type, config: {}, x: 0, y: maxY, w: meta.w * 2, h: meta.h };
    setLayout({ ...layout, widgets: [...layout.widgets, w] });
    setDirty(true);
    setPicker(false);
    if (type !== "locationSummary" && type !== "processDiagram" && type !== "circSequence" && type !== "fertDose" && type !== "weather" && type !== "spaceWeather") setSettingsFor(w);
  };

  const removeWidget = (id: string) => {
    setLayout({ ...layout, widgets: layout.widgets.filter((w) => w.id !== id) });
    setDirty(true);
  };

  const applySettings = (updated: DashboardWidget) => {
    setLayout({ ...layout, widgets: layout.widgets.map((w) => (w.id === updated.id ? updated : w)) });
    setDirty(true);
    setSettingsFor(null);
  };

  /** Quick range change from the Trend card header (no Edit layout). Persists like a Save. */
  const updateTrendRange = async (widgetId: string, rangeHours: number) => {
    const next: DashboardLayout = {
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.id === widgetId && w.type === "trend"
          ? { ...w, config: { ...(w.config as WidgetConfigMap["trend"]), rangeHours } }
          : w,
      ),
    };
    setLayout(next);
    if (editing) {
      setDirty(true);
      return;
    }
    try {
      const res = await saveDashboardLayout(next, layoutId);
      const l = sanitize(res.layout as DashboardLayout, fallback);
      setSaved(l);
      setLayout(l);
      setIsDefault(false);
      setDirty(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const trendRangeSelect = (w: DashboardWidget) => {
    if (w.type !== "trend") return null;
    const hours = (w.config as WidgetConfigMap["trend"]).rangeHours ?? 24;
    return (
      <select
        aria-label="Trend time range"
        className="ml-auto h-6 max-w-[5.5rem] shrink-0 rounded border border-border bg-background px-1 text-[11px] font-mono text-foreground"
        value={hours}
        onChange={(e) => void updateTrendRange(w.id, Number(e.target.value))}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {TREND_RANGES.map((r) => (
          <option key={r.h} value={r.h}>{r.label}</option>
        ))}
      </select>
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await saveDashboardLayout(layout, layoutId);
      const l = sanitize(res.layout as DashboardLayout, fallback);
      setSaved(l);
      setLayout(l);
      setIsDefault(false);
      setDirty(false);
      setEditing(false);
      toast.success("Dashboard saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setLayout(saved ?? sanitize(fallback, fallback));
    setDirty(false);
    setEditing(false);
  };

  const resetToDefault = async () => {
    if (!confirm("Reset the dashboard to the default layout? Your saved layout will be removed.")) return;
    try {
      await resetDashboardLayout(layoutId);
      setSaved(sanitize(fallback, fallback));
      setLayout(sanitize(fallback, fallback));
      setIsDefault(true);
      setDirty(false);
      setEditing(false);
      toast.success("Dashboard reset to default");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="p-4 max-md:p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-mono flex items-center gap-2">
          {titleIcon === "gauge" ? <Gauge className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />} {title}
        </h1>
        {headerExtra}
        {isDefault && !editing && <span className="text-[10px] font-mono uppercase text-muted-foreground">default layout</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[10px] max-md:text-xs font-mono text-muted-foreground">
            API: {data.status === "ok" ? "connected" : data.status}
            {data.error ? ` - ${data.error}` : ""}
          </span>
          {!editing || isMobile ? (
            <>
              <Button size="sm" variant="secondary" onClick={data.refresh} className="max-md:h-11 max-md:px-4 max-md:text-sm">
                <RefreshCw className="h-3 w-3 mr-1 max-md:h-4 max-md:w-4" /> Refresh
              </Button>
              {!isMobile && (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="h-3 w-3 mr-1" /> Edit layout
                </Button>
              )}
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" onClick={() => setPicker(true)}>
                <Plus className="h-3 w-3 mr-1" /> Add widget
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void resetToDefault()}>
                <RotateCcw className="h-3 w-3 mr-1" /> Default
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
                <Save className="h-3 w-3 mr-1" /> {saving ? "Saving…" : "Save"}
              </Button>
            </>
          )}
        </div>
      </div>

      {layout.widgets.length === 0 && (
        <Card className="p-6 text-center text-xs text-muted-foreground">
          No widgets. Click “Edit layout” → “Add widget”.
        </Card>
      )}

      {isMobile ? (
        <div className="grid grid-cols-1 gap-3 min-[600px]:grid-cols-2" data-testid="dashboard-mobile">
          {[...layout.widgets]
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((w) => {
              const h = mobileHeight(w);
              return (
                w.type === "measurementPoint" ? (
                  // self-framed widget: single frame, its own name header (ISA-101 style)
                  <Card key={w.id} className="min-w-0 overflow-hidden bg-card border-border" data-widget={w.type}>
                    <WidgetBody widget={w} />
                  </Card>
                ) : (
                <Card key={w.id} className={`flex min-w-0 flex-col bg-card border-border ${w.type === "statusBits" ? "" : "min-[600px]:col-span-2"}`} style={h ? { height: h } : undefined} data-widget={w.type}>
                  <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
                    <h2 className="min-w-0 flex-1 text-base font-medium leading-6 text-foreground truncate">{w.title || defaultTitle(w, labelFor)}</h2>
                    {trendRangeSelect(w)}
                  </div>
                  <div className={`min-h-0 flex-1 px-3 pb-3 text-sm ${h ? "overflow-auto" : ""}`}>
                    <WidgetBody widget={w} />
                  </div>
                </Card>
                )
              );
            })}
        </div>
      ) : (
        <>
      <style dangerouslySetInnerHTML={{ __html: ".react-grid-placeholder{background:rgb(56 189 248 / 0.28)!important;opacity:1!important;border-radius:0.5rem;}" }} />
      <ResponsiveGrid
        className={editing ? "myko-grid-editing layout" : "layout"}
        layout={gridItems}
        cols={COLS}
        rowHeight={ROW_HEIGHT}
        margin={[12, 12]}
        containerPadding={[0, 0]}
        isDraggable={editing}
        isResizable={editing}
        resizeHandles={["e", "s", "se"]}
        draggableHandle=".myko-drag-handle"
        compactType={null}
        preventCollision
        allowOverlap={false}
        onLayoutChange={onLayoutChange}
        onDragStop={onLayoutChange}
        onResizeStop={onLayoutChange}
      >
        {layout.widgets.map((w) => (
          <div key={w.id}>
            <Card className={`h-full flex flex-col overflow-hidden bg-card ${editing ? "border-primary/50 border-dashed" : "border-border"}`}>
              {(w.type === "measurementPoint" || w.type === "sensorBlock") && !editing ? null : (
              <div className={`flex items-center gap-1 px-3 pt-2 pb-1 ${editing ? "myko-drag-handle cursor-move" : ""}`}>
                {editing && <GripVertical className="h-4 w-4 text-muted-foreground" />}
                <h2 className="min-w-0 flex-1 text-[15px] font-medium leading-6 text-foreground truncate">
                  {w.title || defaultTitle(w, labelFor)}
                </h2>
                {!editing && trendRangeSelect(w)}
                {editing && (
                  <div className="ml-auto flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
                    {(
                      <button className="p-1 text-muted-foreground hover:text-foreground" title="Settings" onClick={() => setSettingsFor(w)}>
                        <Settings2 className="h-3 w-3" />
                      </button>
                    )}
                    <button className="p-1 text-muted-foreground hover:text-destructive" title="Remove" onClick={() => removeWidget(w.id)}>
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
              )}
              <div className={`min-h-0 flex-1 overflow-auto ${w.type === "measurementPoint" || w.type === "processDiagram" || w.type === "alarmList" || w.type === "circSequence" || w.type === "fertDose" ? "px-1 pb-1" : "px-3 pb-3"}`}>
                <WidgetBody widget={w} />
              </div>
            </Card>
          </div>
        ))}
      </ResponsiveGrid>
      </>
      )}

      {picker && (
        <Dialog open onOpenChange={(open) => !open && setPicker(false)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-mono text-sm uppercase">Add widget</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(Object.keys(WIDGET_META) as WidgetType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => addWidget(t)}
                  className="text-left rounded border border-border bg-secondary/20 p-3 hover:bg-secondary"
                >
                  <div className="font-mono text-sm">{WIDGET_META[t].label}</div>
                  <div className="text-xs text-muted-foreground">{WIDGET_META[t].description}</div>
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}

      <WidgetSettingsDialog widget={settingsFor} onClose={() => setSettingsFor(null)} onSave={applySettings} />
    </div>
  );
}
