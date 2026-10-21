import { useEffect, useMemo, useState } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { toast } from "sonner";
import { GripVertical, LayoutGrid, Pencil, Plus, RefreshCw, RotateCcw, Save, Settings2, X } from "lucide-react";
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
  WIDGET_META,
  newWidgetId,
  type DashboardLayout,
  type DashboardWidget,
  type WidgetType,
} from "./types";

const ResponsiveGrid = WidthProvider(GridLayout);
const COLS = 12;
const ROW_HEIGHT = 44;

function sanitize(layout: DashboardLayout | null | undefined): DashboardLayout {
  if (!layout || !Array.isArray(layout.widgets)) return DEFAULT_LAYOUT;
  return {
    version: 1,
    widgets: layout.widgets.filter((w) => w && w.type in WIDGET_META).map((w) => ({ ...w, config: w.config ?? {} })),
  };
}

export function CustomDashboard() {
  // react-grid-layout measures the DOM; render only on the client to avoid SSR mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <DashboardDataProvider>
      {mounted ? <DashboardInner /> : <div className="p-4 text-xs text-muted-foreground font-mono">Loading dashboard…</div>}
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
    case "statusBits":
    case "measurementPoint":
    case "note":
      return undefined; // natural height
    default:
      return Math.min(420, Math.max(200, w.h * ROW_HEIGHT));
  }
}

function DashboardInner() {
  const data = useDashboardData();
  // < 768 px: read-only single column in saved desktop order; the saved grid is never touched here.
  const isMobile = useIsMobile();
  const [saved, setSaved] = useState<DashboardLayout | null>(null);
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_LAYOUT);
  const [isDefault, setIsDefault] = useState(true);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(false);
  const [settingsFor, setSettingsFor] = useState<DashboardWidget | null>(null);

  useEffect(() => {
    getDashboardLayout<DashboardLayout>()
      .then((res) => {
        const l = sanitize(res.layout);
        setSaved(l);
        setLayout(l);
        setIsDefault(!res.layout);
      })
      .catch((e) => toast.error(`Layout load failed: ${(e as Error).message}`));
  }, []);

  const labelFor = (id: string) => data.variables.find((v) => v.id === id)?.label;

  const gridItems: Layout[] = useMemo(
    () =>
      layout.widgets.map((w) => ({
        i: w.id,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        minW: WIDGET_META[w.type].minW,
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
    const w: DashboardWidget = { id: newWidgetId(), type, config: {}, x: 0, y: maxY, w: meta.w, h: meta.h };
    setLayout({ ...layout, widgets: [...layout.widgets, w] });
    setDirty(true);
    setPicker(false);
    if (type !== "locationSummary") setSettingsFor(w);
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

  const save = async () => {
    setSaving(true);
    try {
      const res = await saveDashboardLayout(layout);
      const l = sanitize(res.layout as DashboardLayout);
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
    setLayout(saved ?? DEFAULT_LAYOUT);
    setDirty(false);
    setEditing(false);
  };

  const resetToDefault = async () => {
    if (!confirm("Reset the dashboard to the default layout? Your saved layout will be removed.")) return;
    try {
      await resetDashboardLayout();
      setSaved(DEFAULT_LAYOUT);
      setLayout(DEFAULT_LAYOUT);
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
          <LayoutGrid className="h-4 w-4" /> Dashboard
        </h1>
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
        <div className="flex flex-col gap-3" data-testid="dashboard-mobile">
          {[...layout.widgets]
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((w) => {
              const h = mobileHeight(w);
              return (
                <Card key={w.id} className="flex flex-col bg-card border-border" style={h ? { height: h } : undefined} data-widget={w.type}>
                  <div className="px-3 pt-2.5 pb-1">
                    <h2 className="text-base font-medium leading-6 text-foreground truncate">{w.title || defaultTitle(w, labelFor)}</h2>
                  </div>
                  <div className={`min-h-0 flex-1 px-3 pb-3 text-sm ${h ? "overflow-auto" : ""}`}>
                    <WidgetBody widget={w} />
                  </div>
                </Card>
              );
            })}
        </div>
      ) : (
      <ResponsiveGrid
        className={editing ? "myko-grid-editing" : ""}
        layout={gridItems}
        cols={COLS}
        rowHeight={ROW_HEIGHT}
        margin={[12, 12]}
        containerPadding={[0, 0]}
        isDraggable={editing}
        isResizable={editing}
        resizeHandles={["e", "s", "se"]}
        draggableHandle=".myko-drag-handle"
        compactType="vertical"
        onLayoutChange={onLayoutChange}
      >
        {layout.widgets.map((w) => (
          <div key={w.id}>
            <Card className={`h-full flex flex-col bg-card ${editing ? "border-primary/50 border-dashed" : "border-border"}`}>
              <div className={`flex items-center gap-1 px-3 pt-2 pb-1 ${editing ? "myko-drag-handle cursor-move" : ""}`}>
                {editing && <GripVertical className="h-4 w-4 text-muted-foreground" />}
                <h2 className="text-[15px] font-medium leading-6 text-foreground truncate">
                  {w.title || defaultTitle(w, labelFor)}
                </h2>
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
              <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
                <WidgetBody widget={w} />
              </div>
            </Card>
          </div>
        ))}
      </ResponsiveGrid>
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
