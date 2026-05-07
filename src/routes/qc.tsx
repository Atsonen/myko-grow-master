import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useDataStore } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/common/StatusBadge";
import { FunctionBadge } from "@/components/common/FunctionBadge";
import { TypeBadge } from "@/components/common/TypeBadge";
import { IdentifierTag } from "@/components/common/IdentifierTag";
import { identifierForEvent } from "@/lib/identifier";
import { formatDateTime, relativeTime } from "@/lib/format";
import { AlertTriangle, ShieldAlert, Trash2, Droplets, Wind } from "lucide-react";

export const Route = createFileRoute("/qc")({
  head: () => ({
    meta: [
      { title: "QC / Contamination — Myko Valvomo" },
      { name: "description", content: "Quality control events, contamination risks, and discarded units." },
    ],
  }),
  component: QcPage,
});

function QcPage() {
  const { units, events, strains } = useDataStore();
  const [q, setQ] = useState("");

  const qcEvents = useMemo(
    () => events.filter((e) => e.functionCode === "QC" || e.statusChange === "CONTAMINATED" || e.statusChange === "DISCARDED").sort((a, b) => b.eventTime.localeCompare(a.eventTime)),
    [events],
  );
  const contaminatedUnits = units.filter((u) => u.status === "CONTAMINATED");
  const discardedUnits = units.filter((u) => u.status === "DISCARDED");
  const riskyEvents = qcEvents.filter((e) => /haju|smell|märkä|moist|kuiv|dry|home|contam|trike|vihre/i.test(`${e.title} ${e.note ?? ""}`));

  const filtered = qcEvents.filter((e) => {
    if (!q) return true;
    const unit = units.find((u) => u.code === e.unitCode);
    const strain = strains.find((s) => s.code === unit?.strainCode);
    const text = `${e.unitCode} ${e.title} ${e.note ?? ""} ${unit?.type ?? ""} ${unit?.status ?? ""} ${strain?.code ?? ""}`.toLowerCase();
    return text.includes(q.toLowerCase());
  });

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={<ShieldAlert className="h-4 w-4" />} label="QC events" value={qcEvents.length} />
        <Stat icon={<AlertTriangle className="h-4 w-4 text-status-contaminated" />} label="Contaminated" value={contaminatedUnits.length} danger />
        <Stat icon={<Trash2 className="h-4 w-4 text-muted-foreground" />} label="Discarded" value={discardedUnits.length} />
        <Stat icon={<Droplets className="h-4 w-4 text-status-warning" />} label="Risky notes" value={riskyEvents.length} warning />
      </div>

      <Card className="p-4 bg-card border-border">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Input
            placeholder="Search QC, unit, smell, moisture, trike, home…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-sm h-8 font-mono text-xs"
          />
          <div className="ml-auto text-[10px] font-mono text-muted-foreground">{filtered.length} / {qcEvents.length}</div>
        </div>
        <div className="space-y-2">
          {filtered.map((event) => {
            const unit = units.find((u) => u.code === event.unitCode);
            const strain = strains.find((s) => s.code === unit?.strainCode);
            const note = `${event.title} ${event.note ?? ""}`.toLowerCase();
            const tags = inferRiskTags(note);
            return (
              <div key={event.id} className="border border-border rounded p-3 bg-secondary/20">
                <div className="flex flex-wrap items-start gap-2">
                  <FunctionBadge code={event.functionCode} />
                  {unit && <TypeBadge type={unit.type} />}
                  {unit && <StatusBadge status={unit.status} />}
                  <Link to="/units/$unitCode" params={{ unitCode: event.unitCode }} className="font-mono text-xs text-primary hover:underline">
                    {event.unitCode}
                  </Link>
                  <span className="ml-auto text-[10px] text-muted-foreground">{relativeTime(event.eventTime)}</span>
                </div>
                <div className="mt-2">
                  <IdentifierTag value={identifierForEvent(event, unit, strain)} className="text-[10px]" />
                </div>
                <div className="mt-2 text-sm font-medium">{event.title}</div>
                {event.note && <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{event.note}</div>}
                <div className="mt-2 flex flex-wrap gap-1">
                  {tags.map((tag) => <RiskPill key={tag} tag={tag} />)}
                  {tags.length === 0 && <span className="text-[10px] text-muted-foreground">Logged {formatDateTime(event.eventTime)}</span>}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && <div className="text-xs italic text-muted-foreground p-4 text-center">No QC events match.</div>}
        </div>
      </Card>
    </div>
  );
}

function inferRiskTags(text: string) {
  const tags: string[] = [];
  if (/home|contam|trike|vihre/.test(text)) tags.push("contamination");
  if (/haju|smell|haise/.test(text)) tags.push("bad smell");
  if (/märkä|moist|wet|liika vesi/.test(text)) tags.push("excess moisture");
  if (/kuiv|dry/.test(text)) tags.push("drying");
  if (/pois|roski|discard|häv/.test(text)) tags.push("discarded");
  return tags;
}

function RiskPill({ tag }: { tag: string }) {
  const icon = tag.includes("moist") ? <Droplets className="h-3 w-3" /> : tag.includes("dry") ? <Wind className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />;
  return <span className="inline-flex items-center gap-1 rounded border border-status-warning/40 px-2 py-0.5 text-[10px] font-mono uppercase text-status-warning">{icon}{tag}</span>;
}

function Stat({ icon, label, value, danger, warning }: { icon: React.ReactNode; label: string; value: number; danger?: boolean; warning?: boolean }) {
  const cls = danger ? "border-status-contaminated/40" : warning ? "border-status-warning/40" : "border-border";
  return (
    <div className={`bg-card rounded border ${cls} p-3`}>
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 text-2xl font-mono">{value}</div>
    </div>
  );
}
