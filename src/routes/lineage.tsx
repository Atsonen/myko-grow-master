import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { getStrains, getUnits } from "@/lib/apiClient";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TypeBadge } from "@/components/common/TypeBadge";
import { IdentifierTag } from "@/components/common/IdentifierTag";
import { identifierForUnit } from "@/lib/identifier";
import type { Strain, Unit } from "@/types";
import { GitBranch, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/lineage")({
  head: () => ({
    meta: [
      { title: "Lineage — Myko Valvomo" },
      { name: "description", content: "Structured source-to-target cultivation lineage." },
    ],
  }),
  component: LineagePage,
});

function LineagePage() {
  // Built from the DB origin graph (unit_origins), grouped by effective (inherited) strain.
  const [units, setUnits] = useState<Unit[]>([]);
  const [strains, setStrains] = useState<Strain[]>([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [strainCode, setStrainCode] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    Promise.all([getUnits(), getStrains()]).then(([u, s]) => { setUnits(u); setStrains(s); }).catch((e) => setError((e as Error).message));
  }, []);

  const visible = useMemo(() => units.filter((u) => showHidden || !u.hidden), [units, showHidden]);
  const childrenBySource = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const u of visible) for (const p of u.parentUnitCodes ?? []) {
      const c = map.get(p) ?? []; if (!c.includes(u.code)) c.push(u.code); map.set(p, c);
    }
    return map;
  }, [visible]);
  const codes = useMemo(() => new Set(visible.map((u) => u.code)), [visible]);
  const groups = [
    ...strains.map((s) => ({ key: s.code, title: `#${s.code}`, sub: `${s.name} · ${s.species}` })),
    { key: "__none", title: "No strain", sub: "strain not recorded on the unit or any ancestor" },
  ].filter((g) => !strainCode || g.key === strainCode);

  return (
    <div className="p-4 space-y-4">
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search unit, strain, notes…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm h-8 font-mono text-xs" />
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          Strain:
          <select value={strainCode} onChange={(e) => setStrainCode(e.target.value)} className="h-8 bg-input text-foreground border border-border rounded px-2 text-xs font-mono">
            <option value="">All</option>
            {strains.map((s) => <option key={s.code} value={s.code}>#{s.code}</option>)}
            <option value="__none">No strain</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden
        </label>
      </div>
      <div className="space-y-4">
        {groups.map((g) => {
          const strainUnits = visible.filter((u) => (u.effectiveStrainCode ?? "__none") === g.key);
          // roots: no visible parent inside the graph
          const roots = strainUnits.filter((u) => !(u.parentUnitCodes ?? []).some((p) => codes.has(p) && visible.find((x) => x.code === p && (x.effectiveStrainCode ?? "__none") === g.key)));
          const shown = q ? strainUnits.filter((u) => matches(u, q)) : roots;
          if (q && shown.length === 0) return null;
          return (
            <Card key={g.key} className="p-4 bg-card border-border" data-testid={`lineage-group-${g.key}`}>
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-mono uppercase tracking-wider">{g.title}</h2>
                <span className="text-xs text-muted-foreground">{g.sub}</span>
                <span className="ml-auto text-[10px] font-mono text-muted-foreground">{strainUnits.length} units</span>
              </div>
              <div className="space-y-2">
                {shown.map((root) => <LineageNode key={root.code} unit={root} units={visible} childrenBySource={childrenBySource} depth={0} />)}
                {strainUnits.length === 0 && <div className="text-xs text-muted-foreground italic">No units.</div>}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function LineageNode({
  unit,
  units,
  childrenBySource,
  depth,
}: {
  unit: Unit;
  units: Unit[];
  childrenBySource: Map<string, string[]>;
  depth: number;
}) {
  const childCodes = childrenBySource.get(unit.code) ?? [];
  const children = (depth > 30 ? [] : childCodes.map((code) => units.find((u) => u.code === code)).filter(Boolean)) as Unit[];
  const risky = unit.status === "CONTAMINATED" || unit.status === "DISCARDED";

  return (
    <div className="space-y-2" style={{ marginLeft: depth ? 18 : 0 }}>
      <div className={`border rounded p-2 bg-secondary/20 ${risky ? "border-status-contaminated/50" : "border-border"}`}>
        <div className="flex flex-wrap items-center gap-2">
          {depth > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
          <Link to="/units/$unitCode" params={{ unitCode: unit.code }} className="font-mono text-xs text-primary hover:underline">
            {unit.code}
          </Link>
          <TypeBadge type={unit.type} />
          <StatusBadge status={unit.status} />
          <span className="text-[10px] text-muted-foreground">{unit.effectiveStrainCode ? `#${unit.effectiveStrainCode}` : "—"}</span>
          {(unit.origins ?? []).filter((o) => o.type !== "UNIT").map((o) => <span key={o.id} className="text-[10px] text-muted-foreground">· {o.type.toLowerCase()}</span>)}
        </div>
        <div className="mt-1">
          <IdentifierTag value={identifierForUnit(unit)} className="text-[10px]" />
        </div>
        {unit.notes && <div className="mt-1 text-xs text-muted-foreground">{unit.notes}</div>}
      </div>
      {children.map((child) => (
        <LineageNode key={child.code} unit={child} units={units} childrenBySource={childrenBySource} depth={depth + 1} />
      ))}
    </div>
  );
}

function matches(unit: Unit, q: string) {
  if (!q) return true;
  const text = `${unit.code} ${unit.type} ${unit.strainCode ?? ""} ${unit.status} ${unit.notes ?? ""}`.toLowerCase();
  return text.includes(q.toLowerCase());
}
