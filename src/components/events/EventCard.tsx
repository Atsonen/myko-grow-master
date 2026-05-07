import { FunctionBadge } from "@/components/common/FunctionBadge";
import { IdentifierTag } from "@/components/common/IdentifierTag";
import { dataActions } from "@/store/useDataStore";
import { formatDateTime } from "@/lib/format";
import { identifierForEvent } from "@/lib/identifier";
import type { MEvent, Strain, Unit } from "@/types";
import { Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Droplets, Pencil, Thermometer } from "lucide-react";
import { toast } from "sonner";

export function EventCard({ event, unit, strain, hideUnit }: { event: MEvent; unit?: Unit; strain?: Strain; hideUnit?: boolean }) {
  const toggleArchive = () => {
    if (event.archived) {
      dataActions.restoreEvent(event.id);
      toast.success("Event restored");
    } else {
      dataActions.archiveEvent(event.id);
      toast.success("Event archived");
    }
  };

  return (
    <div className={`border rounded bg-card p-3 space-y-2 ${event.archived ? "border-status-archived/60 opacity-70" : "border-border"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <FunctionBadge code={event.functionCode} />
          {event.archived && <span className="text-[10px] font-mono uppercase text-status-archived border border-status-archived/40 rounded px-1.5 py-0.5">Archived</span>}
          {!hideUnit && unit && (
            <Link
              to="/units/$unitCode"
              params={{ unitCode: unit.code }}
              className="font-mono text-xs text-primary hover:underline"
            >
              {unit.code}
            </Link>
          )}
          {strain && <span className="text-[10px] font-mono text-muted-foreground">#{strain.code}</span>}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">
          {formatDateTime(event.eventTime)}
        </span>
      </div>
      <div className="text-sm flex items-center justify-between gap-2">
        <span>{event.title}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleArchive}
            className="text-muted-foreground hover:text-primary"
            title={event.archived ? "Restore event" : "Archive event"}
          >
            {event.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
          </button>
          <Link
            to="/events/$eventId/edit"
            params={{ eventId: event.id }}
            className="text-muted-foreground hover:text-primary"
            title="Edit event"
          >
            <Pencil className="h-3 w-3" />
          </Link>
        </div>
      </div>
      {event.description && <div className="text-xs text-muted-foreground italic">{event.description}</div>}
      {event.note && <div className="text-xs text-muted-foreground">{event.note}</div>}
      <div className="flex items-center gap-3 text-[11px] font-mono text-muted-foreground">
        {event.temperatureC !== undefined && (
          <span className="flex items-center gap-1"><Thermometer className="h-3 w-3" />{event.temperatureC}°C</span>
        )}
        {event.humidityRh !== undefined && (
          <span className="flex items-center gap-1"><Droplets className="h-3 w-3" />{event.humidityRh}%RH</span>
        )}
        {event.qcTags && event.qcTags.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {event.qcTags.map((t) => (
              <span key={t} className="px-1.5 py-0.5 rounded border border-status-warning/40 text-status-warning text-[9px]">
                {t.replace(/_/g, " ")}
              </span>
            ))}
          </span>
        )}
      </div>
      <IdentifierTag value={identifierForEvent(event, unit, strain)} />
    </div>
  );
}