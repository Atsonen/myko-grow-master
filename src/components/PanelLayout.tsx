// Siirrettävät/koon muutettavat paneelit (react-grid-layout, sama tallennus kuin Dashboardissa: dashboard_layouts ?id=…).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { toast } from "sonner";
import { GripVertical, Pencil, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDashboardLayout, resetDashboardLayout, saveDashboardLayout } from "@/lib/apiClient";
import { useIsMobile } from "@/hooks/use-mobile";

const Grid = WidthProvider(GridLayout);
export type PanelDef = { id: string; title: string; node: ReactNode; x: number; y: number; w: number; h: number; minW?: number; minH?: number };
type Saved = { version: 2; widgets: { id: string; type: string; x: number; y: number; w: number; h: number }[] };

export function PanelLayout({ layoutId, panels, rowHeight = 40, cols = 24 }: { layoutId: string; panels: PanelDef[]; rowHeight?: number; cols?: number }) {
  const isMobile = useIsMobile();
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const [saved, setSaved] = useState<typeof pos>({});
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    getDashboardLayout<Saved>(layoutId).then((r) => {
      const m: typeof pos = {}; for (const w of r.layout?.widgets ?? []) m[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h };
      setPos(m); setSaved(m);
    }).catch(() => undefined);
  }, [layoutId]);
  const items: Layout[] = useMemo(() => panels.map((p) => ({ i: p.id, ...(pos[p.id] ?? { x: p.x, y: p.y, w: p.w, h: p.h }), minW: p.minW ?? 4, minH: p.minH ?? 3 })), [panels, pos]);
  const onChange = (l: Layout[]) => { if (!editing) return; const m: typeof pos = {}; for (const it of l) m[it.i] = { x: it.x, y: it.y, w: it.w, h: it.h }; setPos(m); setDirty(true); };
  const save = async () => {
    try {
      await saveDashboardLayout({ version: 2, widgets: items.map((it) => ({ id: it.i, type: "panel", x: it.x, y: it.y, w: it.w, h: it.h })) }, layoutId);
      setSaved(pos); setDirty(false); setEditing(false); toast.success("Asettelu tallennettu");
    } catch (e) { toast.error((e as Error).message); }
  };
  const reset = async () => {
    if (!confirm("Palautetaanko oletusasettelu?")) return;
    try { await resetDashboardLayout(layoutId); setPos({}); setSaved({}); setDirty(false); setEditing(false); } catch (e) { toast.error((e as Error).message); }
  };
  const toolbar = !isMobile && (
    <div className="flex justify-end gap-2" data-testid="layout-toolbar">
      {!editing ? <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-3 w-3 mr-1" /> Edit layout</Button> : <>
        <Button size="sm" variant="ghost" onClick={() => void reset()}><RotateCcw className="h-3 w-3 mr-1" /> Default</Button>
        <Button size="sm" variant="ghost" onClick={() => { setPos(saved); setDirty(false); setEditing(false); }}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} disabled={!dirty}><Save className="h-3 w-3 mr-1" /> Save</Button>
      </>}
    </div>);
  if (!mounted || isMobile) return <div className="space-y-3">{panels.map((p) => <div key={p.id}>{p.node}</div>)}</div>;
  return (
    <div className="space-y-2">
      {toolbar}
      <Grid className="layout" layout={items} cols={cols} rowHeight={rowHeight} margin={[12, 12]} containerPadding={[0, 0]}
        isDraggable={editing} isResizable={editing} draggableHandle=".panel-drag" onLayoutChange={onChange} compactType={null} preventCollision>
        {panels.map((p) => (
          <div key={p.id} className={`flex flex-col overflow-hidden ${editing ? "rounded-lg ring-1 ring-sky-500/60" : ""}`} data-panel={p.id}>
            {editing && <div className="panel-drag flex cursor-move items-center gap-1 bg-sky-500/15 px-2 py-0.5 text-[11px] font-mono"><GripVertical className="h-3 w-3" />{p.title}</div>}
            <div className="min-h-0 flex-1 overflow-auto">{p.node}</div>
          </div>))}
      </Grid>
    </div>
  );
}
