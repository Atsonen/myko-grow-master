import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useDataStore } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TypeBadge } from "@/components/common/TypeBadge";
import { IdentifierTag } from "@/components/common/IdentifierTag";
import { identifierForUnit } from "@/lib/identifier";
import type { Unit } from "@/types";
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
  const { strains, units, transfers } = useDataStore();
  const [q, setQ] = useState("");
  const [strainCode, setStrainCode] = useState("");

  const filteredStrains = strains.filter((s) => !strainCode || s.code === strainCode);

  const childrenBySource = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of transfers) {
      const children = map.get(t.sourceUnitCode) ?? [];
      children.push(t.targetUnitCode);
      map.set(t.sourceUnitCode, children);
    }
    return map;
  }, [transfers]);

  const hasIncoming = useMemo(() => new Set(transfers.map((t) => t.targetUnitCode)), [transfers]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search unit, strain, notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-sm h-8 font-mono text-xs"
        />
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          Strain:
          <select
            value={strainCode}
            onChange={(e) => setStrainCode(e.target.value)}
            className="h-8 bg-input text-foreground border border-border rounded px-2 text-xs font-mono"
          >
            <option value="">All</option>
            {strains.map((s) => <option key={s.code} value={s.code}>#{s.code}</option>)}
          </select>
        </label>
      </div>

      <div className="space-y-4">
        {filteredStrains.map((strain) => {
          const strainUnits = units.filter((u) => u.strainCode === strain.code);
          const roots = strainUnits.filter((u) => !hasIncoming.has(u.code) || u.type === "LC" || u.type === "PD");
          const shownRoots = roots.filter((u) => matches(u, q));
          if (q && shownRoots.length === 0 && !strainUnits.some((u) => matches(u, q))) return null;
          return (
            <Card key={strain.code} className="p-4 bg-card border-border">
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-mono uppercase tracking-wider">#{strain.code}</h2>
                <span className="text-xs text-muted-foreground">{strain.name} · {strain.species}</span>
                <span className="ml-auto text-[10px] font-mono text-muted-foreground">{strainUnits.length} units</span>
              </div>
              <div className="space-y-2">
                {(q ? strainUnits.filter((u) => matches(u, q)) : shownRoots).map((root) => (
                  <LineageNode key={root.code} unit={root} units={units} childrenBySource={childrenBySource} depth={0} />
                ))}
                {strainUnits.length === 0 && <div className="text-xs text-muted-foreground italic">No units for this strain.</div>}
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
  const children = childCodes.map((code) => units.find((u) => u.code === code)).filter(Boolean) as Unit[];
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
          <span className="text-[10px] text-muted-foreground">#{unit.strainCode}</span>
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
  const text = `${unit.code} ${unit.type} ${unit.strainCode} ${unit.status} ${unit.notes ?? ""}`.toLowerCase();
  return text.includes(q.toLowerCase());
}
