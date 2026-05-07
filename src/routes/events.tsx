import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useDataStore } from "@/store/useDataStore";
import { Input } from "@/components/ui/input";
import { EventCard } from "@/components/events/EventCard";
import type { FunctionCode } from "@/types";

export const Route = createFileRoute("/events")({
  head: () => ({
    meta: [
      { title: "Event Timeline — Myko Valvomo" },
      { name: "description", content: "Global chronological event log across all units." },
    ],
  }),
  component: EventsPage,
});

const FUNCTIONS: FunctionCode[] = ["COL", "FRU", "OBS", "QC", "TRF", "HAR", "PREP"];

function EventsPage() {
  const { events, units, strains } = useDataStore();
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Set<FunctionCode>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  const sorted = [...events]
    .filter((e) => showArchived || !e.archived)
    .sort((a, b) => b.eventTime.localeCompare(a.eventTime));
  const filtered = sorted.filter((e) => {
    if (active.size > 0 && !active.has(e.functionCode)) return false;
    if (q) {
      const u = units.find((x) => x.code === e.unitCode);
      const text = `${e.unitCode} ${u?.strainCode ?? ""} ${e.functionCode} ${e.title} ${e.note ?? ""}`.toLowerCase();
      if (!text.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const toggle = (f: FunctionCode) => {
    setActive((prev) => {
      const n = new Set(prev);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });
  };

  const hiddenCount = events.filter((e) => e.archived).length;

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by unit, strain, function, note…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-sm h-8 font-mono text-xs"
        />
        <div className="flex flex-wrap gap-1">
          {FUNCTIONS.map((f) => (
            <button
              key={f}
              onClick={() => toggle(f)}
              className={`px-2 py-1 rounded border text-[10px] font-mono uppercase tracking-wider ${
                active.has(f)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-secondary text-muted-foreground border-border"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        <div className="ml-auto text-[10px] font-mono text-muted-foreground">
          {filtered.length} events{!showArchived ? ` (${hiddenCount} archived hidden)` : ""}
        </div>
      </div>

      <div className="space-y-2">
        {filtered.map((e) => {
          const u = units.find((x) => x.code === e.unitCode);
          const s = strains.find((x) => x.code === u?.strainCode);
          return <EventCard key={e.id} event={e} unit={u} strain={s} />;
        })}
        {filtered.length === 0 && <div className="text-xs italic text-muted-foreground">No events match.</div>}
      </div>
    </div>
  );
}