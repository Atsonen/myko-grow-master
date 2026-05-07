import { FunctionBadge } from "@/components/common/FunctionBadge";
import { IdentifierTag } from "@/components/common/IdentifierTag";
import { formatDateTime } from "@/lib/format";
import { identifierForEvent } from "@/lib/identifier";
import type { MEvent, Strain, Unit } from "@/types";
import { Link } from "@tanstack/react-router";
import { Droplets, Thermometer } from "lucide-react";

export function EventCard({ event, unit, strain, hideUnit }: { event: MEvent; unit?: Unit; strain?: Strain; hideUnit?: boolean }) {
  return (
    <div className="border border-border rounded bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <FunctionBadge code={event.functionCode} />
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
      <div className="text-sm">{event.title}</div>
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