import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getDbState } from "@/lib/apiClient";
import { Input } from "@/components/ui/input";
import { EventCard } from "@/components/events/EventCard";
import { Card } from "@/components/ui/card";
import type { FunctionCode, MEvent, Strain, Unit } from "@/types";

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
  const [events, setEvents] = useState<MEvent[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [strains, setStrains] = useState<Strain[]>([]);
  const [apiStatus, setApiStatus] = useState<"loading" | "ok" | "error">("loading");
  const [apiError, setApiError] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Set<FunctionCode>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await getDbState();
        if (!cancelled) {
          setEvents(data.events);
          setUnits(data.units);
          setStrains(data.strains);
          setApiStatus("ok");
          setApiError("");
        }
      } catch (error) {
        if (!cancelled) {
          setApiStatus("error");
          setApiError((error as Error).message);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

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
      {apiStatus === "error" && <DbError message={apiError} />}
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
          {apiStatus === "loading" ? "Loading DB..." : `${filtered.length} events${!showArchived ? ` (${hiddenCount} archived hidden)` : ""}`}
        </div>
      </div>

      <div className="space-y-2">
        {filtered.map((e) => {
          const u = units.find((x) => x.code === e.unitCode);
          const s = strains.find((x) => x.code === u?.strainCode);
          return <EventCard key={e.id} event={e} unit={u} strain={s} readOnly />;
        })}
        {filtered.length === 0 && <div className="text-xs italic text-muted-foreground">{apiStatus === "error" ? "DB/API unavailable." : "No events match."}</div>}
      </div>
    </div>
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
