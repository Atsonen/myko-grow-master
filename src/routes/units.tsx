import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useDataStore } from "@/store/useDataStore";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TypeBadge } from "@/components/common/TypeBadge";
import { FunctionBadge } from "@/components/common/FunctionBadge";
import { formatDateTime, relativeTime } from "@/lib/format";
import type { ContainerType, UnitStatus } from "@/types";

export const Route = createFileRoute("/units")({
  head: () => ({
    meta: [
      { title: "Units — Myko Valvomo" },
      { name: "description", content: "Searchable list of all cultivation units." },
    ],
  }),
  component: UnitsPage,
});

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

  const lastEventByUnit = useMemo(() => {
    const map = new Map<string, (typeof events)[number]>();
    for (const e of events) {
      const prev = map.get(e.unitCode);
      if (!prev || e.eventTime > prev.eventTime) map.set(e.unitCode, e);
    }
    return map;
  }, [events]);

  const filtered = units.filter((u) => {
    if (type && u.type !== type) return false;
    if (status && u.status !== status) return false;
    if (strain && u.strainCode !== strain) return false;
    if (substrate && u.substrate !== substrate) return false;
    if (q && !`${u.code} ${u.notes ?? ""} ${u.description ?? ""} ${u.substrate ?? ""} ${u.strainCode}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

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
          options={["", ...strains.map((s) => s.code)]}
          onChange={(v) => setStrain(v)}
        />
        <div className="ml-auto text-[10px] font-mono text-muted-foreground">
          {filtered.length} / {units.length}
        </div>
      </div>

      <Card className="bg-card border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/50 text-muted-foreground uppercase font-mono text-[10px]">
              <tr>
                <th className="text-left p-2">Unit</th>
                <th className="text-left p-2">Type</th>
                <th className="text-left p-2">Substrate</th>
                <th className="text-left p-2">Strain</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Batch</th>
                <th className="text-left p-2">Latest event</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const last = lastEventByUnit.get(u.code);
                return (
                  <tr key={u.code} className="border-t border-border hover:bg-secondary/40">
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
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted-foreground italic">No units match filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
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