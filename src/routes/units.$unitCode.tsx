import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IdentifierTag } from "@/components/common/IdentifierTag";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TypeBadge } from "@/components/common/TypeBadge";
import { EventCard } from "@/components/events/EventCard";
import { formatDateTime, relativeTime } from "@/lib/format";
import { identifierForUnit } from "@/lib/identifier";
import type { UnitStatus } from "@/types";
import { ArrowLeftRight, FlaskConical, History, ShieldAlert, Pencil } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/units/$unitCode")({
  head: ({ params }) => ({
    meta: [
      { title: `${params.unitCode} — Myko Valvomo` },
      { name: "description", content: "Unit detail, event timeline, transfers, and state actions." },
    ],
  }),
  component: UnitDetailPage,
});

function UnitDetailPage() {
  const { unitCode } = Route.useParams();
  const navigate = useNavigate();
  const { units, events, transfers, strains } = useDataStore();

  const unit = units.find((u) => u.code === unitCode);
  const strain = unit ? strains.find((s) => s.code === unit.strainCode) : undefined;

  const unitEvents = useMemo(
    () => events.filter((e) => e.unitCode === unitCode).sort((a, b) => b.eventTime.localeCompare(a.eventTime)),
    [events, unitCode],
  );

  const relatedTransfers = useMemo(
    () =>
      transfers
        .filter((t) => t.sourceUnitCode === unitCode || t.targetUnitCode === unitCode)
        .sort((a, b) => b.transferTime.localeCompare(a.transferTime)),
    [transfers, unitCode],
  );

  if (!unit) {
    return (
      <div className="p-4">
        <Card className="p-6 bg-card border-border">
          <div className="font-mono text-lg">Unit not found</div>
          <p className="text-sm text-muted-foreground mt-2">No unit with code {unitCode} exists in the current dataset.</p>
          <Button className="mt-4" variant="secondary" onClick={() => navigate({ to: "/units" })}>Back to units</Button>
        </Card>
      </div>
    );
  }

  const mark = (status: UnitStatus, title: string) => {
    dataActions.updateUnitStatus(unit.code, status);
    dataActions.addEvent({
      functionCode: status === "CONTAMINATED" ? "QC" : status === "HARVESTED" ? "HAR" : "OBS",
      unitCode: unit.code,
      eventTime: new Date().toISOString(),
      title,
      note: `Status changed to ${status}`,
      statusChange: status,
    });
    toast.success(`${unit.code} marked ${status}`);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4 items-start">
        <div className="space-y-4">
          <Card className="p-4 bg-card border-border">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-mono tracking-tight">{unit.code}</h1>
                  <TypeBadge type={unit.type} />
                  {unit.substrate && <span className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] font-mono uppercase text-muted-foreground">SUB:{unit.substrate}</span>}
                  <StatusBadge status={unit.status} />
                </div>
                <IdentifierTag value={identifierForUnit(unit)} className="text-xs" />
                <div className="text-xs text-muted-foreground">
                  #{unit.strainCode}{strain ? ` · ${strain.name} / ${strain.species}` : ""}
                </div>
                {unit.description && <div className="text-xs italic">{unit.description}</div>}
                {unit.notes && <div className="text-xs text-muted-foreground">{unit.notes}</div>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild>
                  <Link to="/units/$unitCode/edit" params={{ unitCode: unit.code }}>
                    <Pencil className="h-3 w-3 mr-1" /> Edit
                  </Link>
                </Button>
                <Button size="sm" asChild>
                  <Link to="/events/new" search={{ unitCode: unit.code, fn: "OBS" }}>Add observation</Link>
                </Button>
                <Button size="sm" variant="secondary" asChild>
                  <Link to="/events/new" search={{ unitCode: unit.code, fn: "QC" }}>Add QC</Link>
                </Button>
                <Button size="sm" variant="secondary" asChild>
                  <Link to="/transfers/new" search={{ source: unit.code }}>Transfer</Link>
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4 text-xs">
              <Info label="Container type" value={unit.type} />
              <Info label="Substrate" value={unit.substrate ?? "—"} />
              <Info label="Strain" value={`#${unit.strainCode}`} />
              <Info label="Batch time" value={formatDateTime(unit.batchTime)} />
              <Info label="Parent" value={unit.parentUnitCode ?? "—"} />
            </div>
            {unit.notes && <p className="mt-4 text-sm text-muted-foreground border-t border-border pt-3">{unit.notes}</p>}
          </Card>

          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3">
              <History className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">Event timeline</h2>
              <span className="ml-auto text-[10px] font-mono text-muted-foreground">{unitEvents.length} events</span>
            </div>
            <div className="space-y-2">
              {unitEvents.map((event) => <EventCard key={event.id} event={event} unit={unit} strain={strain} />)}
              {unitEvents.length === 0 && <Empty text="No events recorded for this unit." />}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">State actions</h2>
            </div>
            <div className="grid grid-cols-1 gap-2">
              <Button variant="secondary" onClick={() => mark("CONTAMINATED", "Contamination marked")}>Mark contaminated</Button>
              <Button variant="secondary" onClick={() => mark("DISCARDED", "Unit discarded")}>Mark discarded</Button>
              <Button variant="secondary" onClick={() => mark("HARVESTED", "Harvest completed")}>Mark harvested</Button>
              <Button variant="ghost" onClick={() => mark("ARCHIVED", "Unit archived")}>Archive</Button>
            </div>
          </Card>

          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3">
              <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">Transfers</h2>
            </div>
            <div className="space-y-2">
              {relatedTransfers.map((t) => {
                const isSource = t.sourceUnitCode === unit.code;
                const other = isSource ? t.targetUnitCode : t.sourceUnitCode;
                return (
                  <div key={t.id} className="border border-border rounded p-2 text-xs bg-secondary/30">
                    <div className="flex items-center gap-2">
                      <ArrowLeftRight className="h-3 w-3 text-muted-foreground" />
                      <span className="font-mono">{t.sourceUnitCode}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-mono">{t.targetUnitCode}</span>
                    </div>
                    <div className="mt-1 text-muted-foreground">{t.method} · {t.amount} · {relativeTime(t.transferTime)}</div>
                    {other && (
                      <Link to="/units/$unitCode" params={{ unitCode: other }} className="mt-1 inline-block text-primary hover:underline font-mono">
                        Open {other}
                      </Link>
                    )}
                  </div>
                );
              })}
              {relatedTransfers.length === 0 && <Empty text="No structured transfers for this unit." />}
            </div>
          </Card>

          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3">
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">Interpretation</h2>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              +TYPE identifies the container or carrier. Substrate/material is stored separately, so JAR and FCR do not overlap: JAR is the vessel, FCR is the material.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded p-2 bg-secondary/20">
      <div className="text-[10px] font-mono uppercase text-muted-foreground">{label}</div>
      <div className="font-mono truncate">{value}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs text-muted-foreground italic px-2 py-3">— {text} —</div>;
}
