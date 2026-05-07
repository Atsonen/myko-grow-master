import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { FunctionCode, UnitStatus } from "@/types";
import { toast } from "sonner";

const FUNCTIONS: FunctionCode[] = ["COL", "FRU", "OBS", "QC", "TRF", "HAR", "PREP"];
const STATUSES: ("" | UnitStatus)[] = ["", "ACTIVE", "CONTAMINATED", "DISCARDED", "HARVESTED", "ARCHIVED"];

export const Route = createFileRoute("/events/$eventId/edit")({
  head: () => ({ meta: [{ title: "Edit event — Myko Valvomo" }] }),
  component: EditEvent,
});

function EditEvent() {
  const { eventId } = Route.useParams();
  const navigate = useNavigate();
  const { events, units } = useDataStore();
  const ev = events.find((e) => e.id === eventId);

  const [functionCode, setFunctionCode] = useState<FunctionCode>(ev?.functionCode ?? "OBS");
  const [unitCode, setUnitCode] = useState(ev?.unitCode ?? "");
  const [eventTime, setEventTime] = useState(ev ? toLocal(ev.eventTime) : toLocal(new Date().toISOString()));
  const [title, setTitle] = useState(ev?.title ?? "");
  const [description, setDescription] = useState(ev?.description ?? "");
  const [note, setNote] = useState(ev?.note ?? "");
  const [temperatureC, setTemperatureC] = useState(ev?.temperatureC?.toString() ?? "");
  const [humidityRh, setHumidityRh] = useState(ev?.humidityRh?.toString() ?? "");
  const [statusChange, setStatusChange] = useState<"" | UnitStatus>(ev?.statusChange ?? "");

  if (!ev) return <div className="p-4 text-sm">Event not found.</div>;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    dataActions.updateEvent(eventId, {
      functionCode, unitCode,
      eventTime: new Date(eventTime).toISOString(),
      title,
      description: description || undefined,
      note: note || undefined,
      temperatureC: temperatureC ? parseFloat(temperatureC) : undefined,
      humidityRh: humidityRh ? parseFloat(humidityRh) : undefined,
      statusChange: statusChange || undefined,
    });
    toast.success("Event updated");
    navigate({ to: "/units/$unitCode", params: { unitCode } });
  };

  const remove = () => {
    if (!confirm("Delete this event?")) return;
    dataActions.deleteEvent(eventId);
    navigate({ to: "/events" });
  };

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-lg font-mono mb-3">Edit event</h1>
      <Card className="p-4 bg-card border-border">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Function">
            <select value={functionCode} onChange={(e) => setFunctionCode(e.target.value as FunctionCode)} className={selectCls}>
              {FUNCTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          <Field label="Unit">
            <select value={unitCode} onChange={(e) => setUnitCode(e.target.value)} className={selectCls}>
              {units.map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}
            </select>
          </Field>
          <Field label="Event time"><Input type="datetime-local" value={eventTime} onChange={(e) => setEventTime(e.target.value)} className="font-mono text-xs" /></Field>
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
          <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Temperature °C"><Input type="number" step="0.1" value={temperatureC} onChange={(e) => setTemperatureC(e.target.value)} /></Field>
            <Field label="Humidity %RH"><Input type="number" step="1" value={humidityRh} onChange={(e) => setHumidityRh(e.target.value)} /></Field>
          </div>
          <Field label="Status change">
            <select value={statusChange} onChange={(e) => setStatusChange(e.target.value as UnitStatus | "")} className={selectCls}>
              {STATUSES.map((s) => <option key={s} value={s}>{s || "— no change —"}</option>)}
            </select>
          </Field>
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" onClick={remove} className="text-status-contaminated">Delete</Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => navigate({ to: "/events" })}>Cancel</Button>
              <Button type="submit">Save</Button>
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

const selectCls = "h-9 w-full bg-input text-foreground border border-border rounded px-2 text-sm font-mono";

function toLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}