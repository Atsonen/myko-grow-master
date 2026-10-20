import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { KNOWN_LOCATIONS } from "@/lib/locations";
import { bulkHide, bulkLocation, recordEvents } from "@/lib/traceApi";
import { functionOptionLabel } from "@/lib/eventFunctions";

const sel = "h-8 rounded-md border border-input bg-background px-2 text-xs font-mono";
const toLocal = (d: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/** Actions for the units selected in the list: location, hide/unhide, one event to all. */
export function BulkActions({ selected, functions, statuses, unitCodes, onDone }: {
  selected: string[]; functions: string[]; statuses: string[]; unitCodes: string[]; onDone: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [location, setLocation] = useState(KNOWN_LOCATIONS[0]);
  const [customLocation, setCustomLocation] = useState("");
  const [moveTime, setMoveTime] = useState(toLocal(new Date()));
  const [showEvent, setShowEvent] = useState(false);
  const [fn, setFn] = useState("PREP");
  const [title, setTitle] = useState("");
  const [eventTime, setEventTime] = useState(toLocal(new Date()));
  const [note, setNote] = useState("");
  const [statusChange, setStatusChange] = useState("");
  const [source, setSource] = useState("");
  const n = selected.length;

  const run = async (label: string, f: () => Promise<string>) => {
    if (!n) return;
    setBusy(true);
    try { toast.success(await f()); await onDone(); } catch (e) { toast.error(`${label}: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const loc = (location === "__custom" ? customLocation : location).trim().toUpperCase();

  return (
    <Card className="p-2 bg-card border-border space-y-2" data-testid="bulk-actions">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-[10px] text-muted-foreground" data-testid="selected-count">{n} selected</span>
        <select aria-label="Bulk location" className={sel} value={location} onChange={(e) => setLocation(e.target.value)}>
          {KNOWN_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
          <option value="__custom">Other…</option>
        </select>
        {location === "__custom" && <Input aria-label="Custom location" className="h-8 w-40 font-mono text-xs" value={customLocation} onChange={(e) => setCustomLocation(e.target.value)} />}
        <Input aria-label="Moved at" type="datetime-local" className="h-8 w-48 font-mono text-xs" value={moveTime} onChange={(e) => setMoveTime(e.target.value)} />
        <Button size="sm" disabled={busy || !n || !loc} onClick={() => run("Set location", async () => {
          const r = await bulkLocation(selected, loc, new Date(moveTime).toISOString());
          return `Location ${loc}: ${r.moved} moved, ${r.unchanged} already there`;
        })}>Set location</Button>
        <span className="mx-1 text-muted-foreground">|</span>
        <Button size="sm" variant="secondary" disabled={busy || !n} onClick={() => run("Hide", async () => {
          if (!confirm(`Hide ${n} units? They stay in the database with full history; use "Show hidden" to see them.`)) throw new Error("cancelled");
          await bulkHide(selected, true); return `Hidden ${n} units`;
        })}>Hide</Button>
        <Button size="sm" variant="ghost" disabled={busy || !n} onClick={() => run("Unhide", async () => { await bulkHide(selected, false); return `Unhidden ${n} units`; })}>Unhide</Button>
        <span className="mx-1 text-muted-foreground">|</span>
        <Button size="sm" variant={showEvent ? "default" : "secondary"} disabled={!n} onClick={() => setShowEvent((v) => !v)}>Record event…</Button>
      </div>
      {showEvent && (
        <form className="flex flex-wrap items-center gap-2 text-xs border-t border-border pt-2" data-testid="bulk-event-form"
          onSubmit={(e) => { e.preventDefault(); void run("Record event", async () => {
            if (!title.trim()) throw new Error("title required");
            const r = await recordEvents({ unitCodes: selected, functionCode: fn, title: title.trim(), eventTime: new Date(eventTime).toISOString(),
              note: note.trim() || undefined, statusChange: statusChange || undefined, sourceUnitCode: source.trim() || undefined });
            setTitle(""); setNote("");
            return `Recorded ${r.eventIds.length} events (operation ${r.operationId})`;
          }); }}>
          <select aria-label="Event function" className={sel} value={fn} onChange={(e) => setFn(e.target.value)}>
            {functions.map((f) => <option key={f} value={f}>{functionOptionLabel(f)}</option>)}
          </select>
          <Input aria-label="Event title" className="h-8 w-56 text-xs" placeholder="title, e.g. Sterilized 90 min" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input aria-label="Event time" type="datetime-local" className="h-8 w-48 font-mono text-xs" value={eventTime} onChange={(e) => setEventTime(e.target.value)} />
          <Input aria-label="Event note" className="h-8 w-48 text-xs" placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} />
          <select aria-label="Status change" className={sel} value={statusChange} onChange={(e) => setStatusChange(e.target.value)}>
            <option value="">no status change</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Input aria-label="Inoculation source" list="bulk-source-codes" className="h-8 w-44 font-mono text-xs" placeholder="source unit (inoculation)" value={source} onChange={(e) => { setSource(e.target.value.toUpperCase()); if (e.target.value && fn === "PREP") setFn("INOC"); }} />
          <datalist id="bulk-source-codes">{unitCodes.map((c) => <option key={c} value={c} />)}</datalist>
          <Button size="sm" type="submit" disabled={busy}>Record for {n} units</Button>
          <span className="text-[10px] text-muted-foreground">With a source unit, each unit also gets a transfer and the source as parent.</span>
        </form>
      )}
    </Card>
  );
}
