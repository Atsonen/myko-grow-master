import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useDataStore } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import type { Unit } from "@/types";

export const Route = createFileRoute("/lineage/graph")({
  head: () => ({ meta: [{ title: "Lineage graph — Myko Valvomo" }] }),
  component: LineageGraphPage,
});

function LineageGraphPage() {
  const { strains, units, transfers } = useDataStore();
  const navigate = useNavigate();
  const [strainCode, setStrainCode] = useState<string>(strains[0]?.code ?? "");
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<Unit | null>(null);

  const view = useMemo(() => buildLayout(units, transfers, strainCode), [units, transfers, strainCode]);

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-mono">Lineage graph</h1>
        <label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1 ml-2">
          Strain:
          <select value={strainCode} onChange={(e) => setStrainCode(e.target.value)} className="h-8 bg-input border border-border rounded px-2 text-xs font-mono">
            {strains.map((s) => <option key={s.code} value={s.code}>#{s.code}{s.description ? ` — ${s.description}` : ""}</option>)}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))} className="px-2 py-1 text-xs border border-border rounded font-mono">−</button>
          <span className="text-xs font-mono w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(2, z + 0.1))} className="px-2 py-1 text-xs border border-border rounded font-mono">+</button>
        </div>
      </div>

      <Legend />

      <Card className="bg-card border-border overflow-auto">
        <div className="relative">
          <svg
            width={view.width * zoom}
            height={view.height * zoom}
            viewBox={`0 0 ${view.width} ${view.height}`}
            className="block"
          >
            {view.edges.map((e, i) => (
              <path
                key={i}
                d={bezier(e.x1, e.y1, e.x2, e.y2)}
                fill="none"
                stroke={edgeColor(e.targetStatus)}
                strokeWidth={1.5}
                opacity={0.7}
              />
            ))}
            {view.nodes.map((n) => (
              <g
                key={n.unit.code}
                transform={`translate(${n.x},${n.y})`}
                className="cursor-pointer"
                onMouseEnter={() => setHover(n.unit)}
                onMouseLeave={() => setHover(null)}
                onClick={() => navigate({ to: "/units/$unitCode", params: { unitCode: n.unit.code } })}
              >
                <rect width={NODE_W} height={NODE_H} rx={6} ry={6}
                  fill="hsl(var(--card))"
                  stroke={statusStroke(n.unit.status)}
                  strokeWidth={1.5}
                />
                <rect width={4} height={NODE_H} rx={2} ry={2} fill={statusStroke(n.unit.status)} />
                <text x={12} y={20} fontFamily="monospace" fontSize={11} fill="hsl(var(--foreground))">{n.unit.code}</text>
                <text x={12} y={36} fontFamily="monospace" fontSize={9} fill="hsl(var(--muted-foreground))">{n.unit.type} · {n.unit.status}</text>
                {n.unit.description && (
                  <text x={12} y={50} fontFamily="monospace" fontSize={9} fill="hsl(var(--muted-foreground))">
                    {truncate(n.unit.description, 22)}
                  </text>
                )}
              </g>
            ))}
          </svg>
          {hover && (
            <div className="absolute top-2 right-2 bg-popover border border-border rounded p-2 text-xs font-mono shadow-lg max-w-xs">
              <div className="font-bold">{hover.code}</div>
              <div className="text-muted-foreground">{hover.type} · {hover.status} · #{hover.strainCode}</div>
              {hover.description && <div className="mt-1">{hover.description}</div>}
              {hover.notes && <div className="mt-1 text-muted-foreground">{hover.notes}</div>}
            </div>
          )}
          {view.nodes.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">No units for this strain.</div>
          )}
        </div>
      </Card>
    </div>
  );
}

const NODE_W = 160;
const NODE_H = 60;
const COL_GAP = 80;
const ROW_GAP = 20;

function buildLayout(allUnits: Unit[], transfers: { sourceUnitCode: string; targetUnitCode: string }[], strainCode: string) {
  const units = allUnits.filter((u) => u.strainCode === strainCode);
  const codes = new Set(units.map((u) => u.code));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const t of transfers) {
    if (!codes.has(t.sourceUnitCode) || !codes.has(t.targetUnitCode)) continue;
    parents.set(t.targetUnitCode, [...(parents.get(t.targetUnitCode) ?? []), t.sourceUnitCode]);
    children.set(t.sourceUnitCode, [...(children.get(t.sourceUnitCode) ?? []), t.targetUnitCode]);
  }
  // Also use parentUnitCode field as fallback
  for (const u of units) {
    if (u.parentUnitCode && codes.has(u.parentUnitCode) && !(parents.get(u.code) ?? []).includes(u.parentUnitCode)) {
      parents.set(u.code, [...(parents.get(u.code) ?? []), u.parentUnitCode]);
      children.set(u.parentUnitCode, [...(children.get(u.parentUnitCode) ?? []), u.code]);
    }
  }

  // depth = longest path from any root
  const depth = new Map<string, number>();
  const visit = (code: string, seen = new Set<string>()): number => {
    if (depth.has(code)) return depth.get(code)!;
    if (seen.has(code)) return 0;
    seen.add(code);
    const ps = parents.get(code) ?? [];
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => visit(p, seen)));
    depth.set(code, d);
    return d;
  };
  units.forEach((u) => visit(u.code));

  // group by depth
  const cols = new Map<number, Unit[]>();
  for (const u of units) {
    const d = depth.get(u.code) ?? 0;
    cols.set(d, [...(cols.get(d) ?? []), u]);
  }
  // sort each column by type then code
  const typeOrder = ["LC", "PD", "JAR", "BAG", "BOX", "OTHER"];
  for (const arr of cols.values()) {
    arr.sort((a, b) => (typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type)) || a.code.localeCompare(b.code));
  }

  const positions = new Map<string, { x: number; y: number }>();
  const sortedDepths = [...cols.keys()].sort((a, b) => a - b);
  let maxRows = 0;
  for (const d of sortedDepths) {
    const arr = cols.get(d)!;
    maxRows = Math.max(maxRows, arr.length);
    arr.forEach((u, i) => {
      positions.set(u.code, { x: 20 + d * (NODE_W + COL_GAP), y: 20 + i * (NODE_H + ROW_GAP) });
    });
  }

  const nodes = units.map((u) => ({ unit: u, ...(positions.get(u.code) ?? { x: 0, y: 0 }) }));
  const edges: { x1: number; y1: number; x2: number; y2: number; targetStatus: string }[] = [];
  for (const [target, ps] of parents.entries()) {
    const tp = positions.get(target);
    const tu = units.find((u) => u.code === target);
    if (!tp || !tu) continue;
    for (const src of ps) {
      const sp = positions.get(src);
      if (!sp) continue;
      edges.push({
        x1: sp.x + NODE_W,
        y1: sp.y + NODE_H / 2,
        x2: tp.x,
        y2: tp.y + NODE_H / 2,
        targetStatus: tu.status,
      });
    }
  }

  const width = Math.max(400, 40 + (sortedDepths.length || 1) * (NODE_W + COL_GAP));
  const height = Math.max(200, 40 + maxRows * (NODE_H + ROW_GAP));
  return { nodes, edges, width, height };
}

function bezier(x1: number, y1: number, x2: number, y2: number) {
  const dx = (x2 - x1) / 2;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

function statusStroke(status: string) {
  switch (status) {
    case "CONTAMINATED": return "hsl(var(--status-contaminated, 0 70% 55%))";
    case "HARVESTED": return "hsl(var(--status-harvested, 140 50% 45%))";
    case "DISCARDED":
    case "ARCHIVED": return "hsl(var(--muted-foreground))";
    default: return "hsl(var(--primary))";
  }
}

function edgeColor(status: string) {
  if (status === "CONTAMINATED") return "hsl(var(--status-contaminated, 0 70% 55%))";
  if (status === "HARVESTED") return "hsl(var(--status-harvested, 140 50% 45%))";
  return "hsl(var(--muted-foreground))";
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function Legend() {
  const items = [
    { label: "Active", color: "hsl(var(--primary))" },
    { label: "Contaminated", color: "hsl(var(--status-contaminated, 0 70% 55%))" },
    { label: "Harvested", color: "hsl(var(--status-harvested, 140 50% 45%))" },
    { label: "Archived/Discarded", color: "hsl(var(--muted-foreground))" },
  ];
  return (
    <div className="flex flex-wrap gap-3 text-[10px] font-mono uppercase text-muted-foreground">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ background: i.color }} />
          {i.label}
        </div>
      ))}
      <span className="ml-auto">Click a node to open the unit detail.</span>
    </div>
  );
}