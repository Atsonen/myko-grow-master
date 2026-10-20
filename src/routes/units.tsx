import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  archiveUnits,
  createUnit as createUnitInDb,
  getEvents,
  getStrains,
  getTaxonomy,
  getUnits,
} from "@/lib/apiClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TypeBadge } from "@/components/common/TypeBadge";
import { FunctionBadge } from "@/components/common/FunctionBadge";
import { formatDateTime, relativeTime } from "@/lib/format";
import type { ContainerType, MEvent, Strain, Unit, UnitStatus } from "@/types";
import { Archive, ArrowDownUp, Pencil } from "lucide-react";
import type { Taxonomy } from "@/store/useDataStore";
import { toast } from "sonner";

export const Route = createFileRoute("/units")({
  head: () => ({
    meta: [
      { title: "Units — Myko Valvomo" },
      { name: "description", content: "Searchable list of all cultivation units." },
    ],
  }),
  component: UnitsLayout,
});

type SortKey = "code" | "type" | "substrate" | "strain" | "status" | "batch" | "latest";
type SortDirection = "asc" | "desc";

function UnitsLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isChild = path !== "/units";

  return isChild ? <Outlet /> : <UnitsIndex />;
}

function UnitsIndex() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [events, setEvents] = useState<MEvent[]>([]);
  const [strains, setStrains] = useState<Strain[]>([]);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>({
    functions: [],
    types: [],
    statuses: [],
    qcTags: [],
  });
  const [apiStatus, setApiStatus] = useState<"loading" | "ok" | "error">("loading");
  const [apiError, setApiError] = useState("");
  const TYPES = taxonomy.types as ContainerType[];
  const STATUSES = taxonomy.statuses as UnitStatus[];
  const SUBSTRATES = Array.from(
    new Set(units.map((u) => u.substrate).filter(Boolean) as string[]),
  ).sort();
  const [q, setQ] = useState("");
  const [type, setType] = useState<"" | ContainerType>("");
  const [status, setStatus] = useState<"" | UnitStatus>("");
  const [strain, setStrain] = useState<string>("");
  const [substrate, setSubstrate] = useState<string>("");
  const [showArchived, setShowArchived] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("batch");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showNewUnitForm, setShowNewUnitForm] = useState(false);
  const [newUnitCode, setNewUnitCode] = useState("");
  const [newUnitType, setNewUnitType] = useState<ContainerType>(
    TYPES[0] ?? ("BOX" as ContainerType),
  );
  const [newUnitStrainCode, setNewUnitStrainCode] = useState("");
  const [newUnitStatus, setNewUnitStatus] = useState<UnitStatus>(
    STATUSES[0] ?? ("ACTIVE" as UnitStatus),
  );
  const [newUnitBatchTime, setNewUnitBatchTime] = useState(toLocal(new Date().toISOString()));
  const [newUnitParentCode, setNewUnitParentCode] = useState("");
  const [newUnitSubstrate, setNewUnitSubstrate] = useState("");
  const [newUnitLocation, setNewUnitLocation] = useState("");
  const [newUnitDescription, setNewUnitDescription] = useState("");
  const [newUnitNotes, setNewUnitNotes] = useState("");
  const [creatingUnit, setCreatingUnit] = useState(false);

  const loadDbState = async (cancelled?: () => boolean) => {
    try {
      const [loadedUnits, loadedEvents, loadedStrains, loadedTaxonomy] = await Promise.all([
        getUnits(),
        getEvents(),
        getStrains(),
        getTaxonomy(),
      ]);
      if (!cancelled?.()) {
        setUnits(loadedUnits);
        setEvents(loadedEvents);
        setStrains(loadedStrains);
        setTaxonomy(loadedTaxonomy);
        setApiStatus("ok");
        setApiError("");
      }
    } catch (error) {
      if (!cancelled?.()) {
        setApiStatus("error");
        setApiError((error as Error).message);
      }
    }
  };

  const resetNewUnitForm = () => {
    setNewUnitCode("");
    setNewUnitType(TYPES[0] ?? ("BOX" as ContainerType));
    setNewUnitStrainCode(strains[0]?.code ?? "");
    setNewUnitStatus(STATUSES[0] ?? ("ACTIVE" as UnitStatus));
    setNewUnitBatchTime(toLocal(new Date().toISOString()));
    setNewUnitParentCode("");
    setNewUnitSubstrate("");
    setNewUnitLocation("");
    setNewUnitDescription("");
    setNewUnitNotes("");
  };

  useEffect(() => {
    let cancelled = false;
    void loadDbState(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleEvents = useMemo(
    () => events.filter((e) => showArchived || !e.archived),
    [events, showArchived],
  );
  const visibleUnits = useMemo(
    () => units.filter((u) => showArchived || u.status !== "ARCHIVED"),
    [units, showArchived],
  );

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
    if (
      q &&
      !`${u.code} ${u.notes ?? ""} ${u.description ?? ""} ${u.substrate ?? ""} ${u.strainCode}`
        .toLowerCase()
        .includes(q.toLowerCase())
    )
      return false;
    return true;
  });

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) =>
      compareUnits(a, b, sortKey, sortDirection, lastEventByUnit),
    );
  }, [filtered, sortKey, sortDirection, lastEventByUnit]);

  const selectableCodes = sorted.filter((u) => u.status !== "ARCHIVED").map((u) => u.code);
  const visibleSelectedCount = selectableCodes.filter((code) => selected.has(code)).length;
  const allVisibleSelected =
    selectableCodes.length > 0 && visibleSelectedCount === selectableCodes.length;

  const setSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection(key === "batch" || key === "latest" ? "desc" : "asc");
    }
  };

  const toggleSelected = (code: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const code of selectableCodes) {
        if (checked) next.add(code);
        else next.delete(code);
      }
      return next;
    });
  };

  const archiveSelected = async () => {
    const unitCodes = Array.from(selected).filter(
      (code) => units.find((u) => u.code === code)?.status !== "ARCHIVED",
    );
    if (unitCodes.length === 0) return;
    if (
      !confirm(
        `Archive ${unitCodes.length} selected units? This hides them from normal operational views and writes archive events.`,
      )
    )
      return;

    setBulkBusy(true);
    try {
      const result = await archiveUnits(unitCodes);
      setSelected(new Set());
      await loadDbState();
      toast.success(`Archived ${result.counts.units} units`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const availableStrains = strains.filter((s) => showArchived || !s.archived);

  const handleCreateUnit = async (event: React.FormEvent) => {
    event.preventDefault();
    const code = newUnitCode.trim().toUpperCase();
    if (!code) return toast.error("Unit code is required");
    if (!newUnitStrainCode) return toast.error("Strain is required");
    if (!newUnitBatchTime) return toast.error("Batch time is required");

    setCreatingUnit(true);
    try {
      await createUnitInDb({
        code,
        type: newUnitType,
        strainCode: newUnitStrainCode,
        status: newUnitStatus,
        batchTime: new Date(newUnitBatchTime).toISOString(),
        parentUnitCode: newUnitParentCode || undefined,
        substrate: newUnitSubstrate.trim() || undefined,
        currentLocation: newUnitLocation.trim() || undefined,
        description: newUnitDescription.trim() || undefined,
        notes: newUnitNotes.trim() || undefined,
      });
      toast.success(`Created unit ${code}`);
      setShowNewUnitForm(false);
      resetNewUnitForm();
      await loadDbState();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setCreatingUnit(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      {apiStatus === "error" && <DbError message={apiError} />}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search unit code, notes, substrate…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs h-8 font-mono text-xs"
        />
        <Pill
          label="Type"
          value={type}
          options={["", ...TYPES]}
          onChange={(v) => setType(v as ContainerType | "")}
        />
        <Pill
          label="Substrate"
          value={substrate}
          options={["", ...SUBSTRATES]}
          onChange={setSubstrate}
        />
        <Pill
          label="Status"
          value={status}
          options={["", ...STATUSES]}
          onChange={(v) => setStatus(v as UnitStatus | "")}
        />
        <Pill
          label="Strain"
          value={strain}
          options={["", ...strains.filter((s) => showArchived || !s.archived).map((s) => s.code)]}
          onChange={(v) => setStrain(v)}
        />
        <Button size="sm" variant="secondary" onClick={() => setShowNewUnitForm((prev) => !prev)}>
          {showNewUnitForm ? "Hide new unit" : "Add new unit"}
        </Button>
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        <div className="ml-auto text-[10px] font-mono text-muted-foreground">
          {apiStatus === "loading"
            ? "Loading DB..."
            : `${sorted.length} / ${visibleUnits.length}${!showArchived ? ` (${units.length - visibleUnits.length} archived hidden)` : ""}`}
        </div>
      </div>
      {showNewUnitForm ? (
        <Card className="p-4 bg-card border-border space-y-3">
          <div className="text-sm font-medium">Create new unit</div>
          <form onSubmit={handleCreateUnit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Unit code">
                <Input
                  value={newUnitCode}
                  onChange={(e) => setNewUnitCode(e.target.value.toUpperCase())}
                  className="font-mono"
                  placeholder="U123"
                />
              </Field>
              <Field label="Container type">
                <select
                  value={newUnitType}
                  onChange={(e) => setNewUnitType(e.target.value as ContainerType)}
                  className={selectCls}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Strain">
                <select
                  value={newUnitStrainCode}
                  onChange={(e) => setNewUnitStrainCode(e.target.value)}
                  className={selectCls}
                >
                  <option value="">Select strain</option>
                  {availableStrains.map((s) => (
                    <option key={s.code} value={s.code}>
                      #{s.code} - {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <select
                  value={newUnitStatus}
                  onChange={(e) => setNewUnitStatus(e.target.value as UnitStatus)}
                  className={selectCls}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Batch time">
                <Input
                  type="datetime-local"
                  value={newUnitBatchTime}
                  onChange={(e) => setNewUnitBatchTime(e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Parent unit (optional)">
                <select
                  value={newUnitParentCode}
                  onChange={(e) => setNewUnitParentCode(e.target.value)}
                  className={selectCls}
                >
                  <option value="">none</option>
                  {units
                    .filter((u) => u.code !== newUnitCode)
                    .map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.code}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
            <Field label="Substrate / material">
              <Input
                value={newUnitSubstrate}
                onChange={(e) => setNewUnitSubstrate(e.target.value.toUpperCase())}
                className="font-mono"
              />
            </Field>
            <Field label="Current location">
              <Input
                value={newUnitLocation}
                onChange={(e) => setNewUnitLocation(e.target.value.toUpperCase())}
                className="font-mono"
              />
            </Field>
            <Field label="Description">
              <Textarea
                value={newUnitDescription}
                onChange={(e) => setNewUnitDescription(e.target.value)}
                rows={2}
              />
            </Field>
            <Field label="Notes">
              <Textarea
                value={newUnitNotes}
                onChange={(e) => setNewUnitNotes(e.target.value)}
                rows={2}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={creatingUnit}>
                {creatingUnit ? "Creating..." : "Create unit"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowNewUnitForm(false);
                  resetNewUnitForm();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={bulkBusy || selected.size === 0}
          onClick={archiveSelected}
        >
          <Archive className="h-3 w-3 mr-1" /> Archive selected
        </Button>
        <div className="text-[10px] font-mono text-muted-foreground">{selected.size} selected</div>
      </div>

      <Card className="bg-card border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/50 text-muted-foreground uppercase font-mono text-[10px]">
              <tr>
                <th className="text-left p-2 w-8">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    disabled={selectableCodes.length === 0}
                    onChange={(e) => toggleAllVisible(e.target.checked)}
                    title="Select visible units"
                  />
                </th>
                <SortableHeader
                  label="Unit"
                  sortKey="code"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={setSort}
                />
                <SortableHeader
                  label="Type"
                  sortKey="type"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={setSort}
                />
                <SortableHeader
                  label="Substrate"
                  sortKey="substrate"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={setSort}
                />
                <SortableHeader
                  label="Strain"
                  sortKey="strain"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={setSort}
                />
                <SortableHeader
                  label="Status"
                  sortKey="status"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={setSort}
                />
                <SortableHeader
                  label="Batch"
                  sortKey="batch"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={setSort}
                />
                <SortableHeader
                  label="Latest event"
                  sortKey="latest"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={setSort}
                />
                <th className="text-left p-2">Edit</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => {
                const last = lastEventByUnit.get(u.code);
                return (
                  <tr
                    key={u.code}
                    className={`border-t border-border hover:bg-secondary/40 ${u.status === "ARCHIVED" ? "opacity-60" : ""}`}
                  >
                    <td className="p-2">
                      <input
                        type="checkbox"
                        checked={selected.has(u.code)}
                        disabled={u.status === "ARCHIVED"}
                        onChange={(e) => toggleSelected(u.code, e.target.checked)}
                        title={`Select ${u.code}`}
                      />
                    </td>
                    <td className="p-2">
                      <Link
                        to="/units/$unitCode"
                        params={{ unitCode: u.code }}
                        className="font-mono text-primary hover:underline"
                      >
                        {u.code}
                      </Link>
                    </td>
                    <td className="p-2">
                      <TypeBadge type={u.type} />
                    </td>
                    <td className="p-2 font-mono text-muted-foreground">
                      {u.substrate ? (
                        <span className="rounded border border-border bg-muted px-2 py-0.5">
                          {u.substrate}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-2 font-mono">#{u.strainCode}</td>
                    <td className="p-2">
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="p-2 text-muted-foreground">{formatDateTime(u.batchTime)}</td>
                    <td className="p-2">
                      {last ? (
                        <div className="flex items-center gap-2">
                          <FunctionBadge code={last.functionCode} />
                          <span className="truncate max-w-[280px]">{last.title}</span>
                          <span className="text-[10px] text-muted-foreground ml-auto">
                            {relativeTime(last.eventTime)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      <Link
                        to="/units/$unitCode/edit"
                        params={{ unitCode: u.code }}
                        title={`Edit ${u.code}`}
                        aria-label={`Edit ${u.code}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <Pencil className="h-3 w-3" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-muted-foreground italic">
                    {apiStatus === "error" ? "DB/API unavailable." : "No units match filters."}
                  </td>
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
        {active ? (
          <span>{direction === "asc" ? "↑" : "↓"}</span>
        ) : (
          <ArrowDownUp className="h-3 w-3 opacity-50" />
        )}
      </button>
    </th>
  );
}

function DbError({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40 bg-destructive/10 p-3">
      <div className="text-sm font-medium">DB/API unavailable</div>
      <div className="text-xs text-muted-foreground mt-1">{message}</div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

const selectCls =
  "h-9 w-full bg-input text-foreground border border-border rounded px-2 text-sm font-mono";

function toLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
      case "code":
        return u.code;
      case "type":
        return u.type;
      case "substrate":
        return u.substrate ?? "";
      case "strain":
        return u.strainCode;
      case "status":
        return u.status;
      case "batch":
        return new Date(u.batchTime).getTime() || 0;
      case "latest":
        return new Date(lastEventByUnit.get(u.code)?.eventTime ?? u.batchTime).getTime() || 0;
      default:
        return u.code;
    }
  };

  const av = getValue(a);
  const bv = getValue(b);
  if (typeof av === "number" && typeof bv === "number") return (av - bv) * multiplier;
  const primary =
    String(av).localeCompare(String(bv), "fi", { numeric: true, sensitivity: "base" }) * multiplier;
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
