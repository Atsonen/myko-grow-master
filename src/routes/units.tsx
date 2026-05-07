import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TypeBadge } from "@/components/common/TypeBadge";
import { FunctionBadge } from "@/components/common/FunctionBadge";
import { formatDateTime, relativeTime } from "@/lib/format";
import type { ContainerType, Unit, UnitStatus } from "@/types";
import { Archive, ArchiveRestore, ArrowDownUp, Pencil } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/units")({
  head: () => ({
    meta: [
      { title: "Units — Myko Valvomo" },
      { name: "description", content: "Searchable list of all cultivation units." },
    ],
  }),
  component: UnitsPage,
});

type SortKey = "code" | "type" | "substrate" | "strain" | "status" | "batch" | "latest";
type SortDirection = "asc" | "desc";

function UnitsPage() {
  const { units, events, strains, taxonomy } = useDataStore();
  const TYPES = taxonomy.types as ContainerType[];
  const STATUSES = taxonomy.statuses as UnitStatus[];
  const SUBSTRATES = Array.from(new Set(units.map((u) => u.substrate).filter(Boolean) as string[])).sort();
  const [q, setQ] = useState("");
  const [type, setType] = useState<"" | ContainerType>("");
  const [status, setStatus] = useState<"" | UnitStatus>("");
  const [strain, setStrain] = useState<string>("");
  const [substrate, setSubstrate] = useState<string>("");
  const [showArchived, setShowArchived] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("batch");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const visibleEvents = useMemo(() => events.filter((e) => showArchived || !e.archived), [events, showArchived]);
  const visibleUnits = useMemo(() => units.filter((u) => showArchived || u.status !== "ARCHIVED"), [units, showArchived]);

  const lastEventByUnit = useMemo(() => {
    const map = new Map<string, (typeof events)[number]>();
    for (const e of visibleEvents) {
      const prev = map.get(e.unitCode);
      if (!prev || e.eventTime > prev.eventTime) map.set(e.unitCode, e);
    }
    return map;
  }, [visibleEvents]);

  const filtered = visibleUnits.filter((u) => {
    if (type && u.type !== type) return false;
    if (status && u.status !== status) return false;
    if (strain && u.strainCode !== strain) return false;
    if (substrate && u.substrate !== substrate) return false;
    if (q && !`${u.code} ${u.notes ?? ""} ${u.description ?? ""} ${u.substrate ?? ""} ${u.strainCode}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => compareUnits(a, b, sortKey, sortDirection, lastEventByUnit));
  }, [filtered, sortKey, sortDirection, lastEventByUnit]);

  const setSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection(key === "batch" || key === "latest" ? "desc" : "asc");
    }
  };

  const archiveUnit = (code: string) => {
    if (!confirm(`Archive ${code}? Use this when the physical container no longer exists. It will be hidden from normal views.`)) return;
    dataActions.archiveUnit(code);
    dataActions.addEvent({
      functionCode: "OBS",
      unitCode: code,
      eventTime: new Date().toISOString(),
      title: "Physical unit archived",
      note: "Physical container no longer exists. Unit hidden from normal views.",
      statusChange: "ARCHIVED",
    });
    toast.success(`${code} archived`);
  };

  const restoreUnit = (code: string) => {
    dataActions.restoreUnit(code, "ACTIVE");
    dataActions.addEvent({
      functionCode: "OBS",
      unitCode: code,
      eventTime: new Date().toISOString(),
      title: "Physical unit restored",
      note: "Unit restored to ACTIVE status.",
      statusChange: "ACTIVE",
    });
    toast.success(`${code} restored`);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search unit code, notes, substrate…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs h-8 font-mono text-xs"
        />
        <Pill label="Type" value={type} options={["", ...TYPES]} onChange={(v) => setType(v as ContainerType | "")} />
        <Pill label="Substrate" value={substrate} options={["", ...SUBSTRATES]} onChange={setSubstrate} />
        <Pill label="Status" value={status} options={["", ...STATUSES]} onChange={(v) => setStatus(v as UnitStatus | "")} />
        <Pill
          label="Strain"
          value={strain}
          options={["", ...strains.filter((s) => showArchived || !s.archived).map((s) => s.code)]}
          onChange={(v) => setStrain(v)}
        />
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        <div className="ml-auto text-[10px] font-mono text-muted-foreground">
          {sorted.length} / {visibleUnits.length}{!showArchived ? ` (${units.length - visibleUnits.length} archived hidden)` : ""}
        </div>
      </div>

      <Card className="bg-card border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/50 text-muted-foreground uppercase font-mono text-[10px]">
              <tr>
                <SortableHeader label="Unit" sortKey="code" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
                <SortableHeader label="Type" sortKey="type" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
                <SortableHeader label="Substrate" sortKey="substrate" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
                <SortableHeader label="Strain" sortKey="strain" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
                <SortableHeader label="Status" sortKey="status" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
                <SortableHeader label="Batch" sortKey="batch" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
                <SortableHeader label="Latest event" sortKey="latest" activeKey={sortKey} direction={sortDirection} onSort={setSort} />
                <th className="text-left p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => {
                const last = lastEventByUnit.get(u.code);
                return (
                  <tr key={u.code} className={`border-t border-border hover:bg-secondary/40 ${u.status === "ARCHIVED" ? "opacity-60" : ""}`}>
                    <td className="p-2">
                      <Link
                        to="/units/$unitCode"
                        params={{ unitCode: u.code }}
                        className="font-mono text-primary hover:underline"
                      >
                        {u.code}
                      </Link>
                    </td>
                    <td className="p-2"><TypeBadge type={u.type} /></td>
                    <td className="p-2 font-mono text-muted-foreground">{u.substrate ? <span className="rounded border border-border bg-muted px-2 py-0.5">{u.substrate}</span> : "—"}</td>
                    <td className="p-2 font-mono">#{u.strainCode}</td>
                    <td className="p-2"><StatusBadge status={u.status} /></td>
                    <td className="p-2 text-muted-foreground">{formatDateTime(u.batchTime)}</td>
                    <td className="p-2">
                      {last ? (
                        <div className="flex items-center gap-2">
                          <FunctionBadge code={last.functionCode} />
                          <span className="truncate max-w-[280px]">{last.title}</span>
                          <span className="text-[10px] text-muted-foreground ml-auto">{relativeTime(last.eventTime)}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        {u.status === "ARCHIVED" ? (
                          <Button size="sm" variant="secondary" onClick={() => restoreUnit(u.code)} title="Restore unit to active">
                            <ArchiveRestore className="h-3 w-3" />
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => archiveUnit(u.code)} title="Archive physical unit">
                            <Archive className="h-3 w-3" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" asChild title="Edit unit">
                          <Link to="/units/$unitCode/edit" params={{ unitCode: u.code }}><Pencil className="h-3 w-3" /></Link>
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground italic">No units match filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <th className="text-left p-2">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : "text-muted-foreground"}`}
        title={`Sort by ${label}`}
      >
        {label}
        {active ? <span>{direction === "asc" ? "↑" : "↓"}</span> : <ArrowDownUp className="h-3 w-3 opacity-50" />}
      </button>
    </th>
  );
}

function compareUnits(
  a: Unit,
  b: Unit,
  key: SortKey,
  direction: SortDirection,
  lastEventByUnit: Map<string, { eventTime: string }>,
) {
  const multiplier = direction === "asc" ? 1 : -1;
  const getValue = (u: Unit) => {
    switch (key) {
      case "code": return u.code;
      case "type": return u.type;
      case "substrate": return u.substrate ?? "";
      case "strain": return u.strainCode;
      case "status": return u.status;
      case "batch": return new Date(u.batchTime).getTime() || 0;
      case "latest": return new Date(lastEventByUnit.get(u.code)?.eventTime ?? u.batchTime).getTime() || 0;
      default: return u.code;
    }
  };

  const av = getValue(a);
  const bv = getValue(b);
  if (typeof av === "number" && typeof bv === "number") return (av - bv) * multiplier;
  const primary = String(av).localeCompare(String(bv), "fi", { numeric: true, sensitivity: "base" }) * multiplier;
  if (primary !== 0) return primary;
  return a.code.localeCompare(b.code, "fi", { numeric: true, sensitivity: "base" });
}

function Pill({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
      {label}:
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 bg-input text-foreground border border-border rounded px-2 text-xs font-mono"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o || "All"}
          </option>
        ))}
      </select>
    </label>
  );
}