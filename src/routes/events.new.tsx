import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IdentifierTag } from "@/components/common/IdentifierTag";
import { buildIdentifier } from "@/lib/identifier";
import type { FunctionCode, UnitStatus } from "@/types";
import { toast } from "sonner";

const searchSchema = z.object({
  unitCode: z.string().optional(),
  fn: z.enum(["COL", "FRU", "OBS", "QC", "TRF", "HAR", "PREP"]).optional(),
});

export const Route = createFileRoute("/events/new")({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Add event — Myko Valvomo" }] }),
  component: AddEventPage,
});

function AddEventPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { units, taxonomy } = useDataStore();
  const FUNCTIONS = taxonomy.functions as FunctionCode[];
  const STATUSES: ("" | UnitStatus)[] = ["", ...(taxonomy.statuses as UnitStatus[])];

  const [functionCode, setFunctionCode] = useState<FunctionCode>(search.fn ?? "OBS");
  const [unitCode, setUnitCode] = useState<string>(search.unitCode ?? units[0]?.code ?? "");
  const [eventTime, setEventTime] = useState(toLocalInput(new Date()));
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [temperatureC, setTemperatureC] = useState<string>("");
  const [humidityRh, setHumidityRh] = useState<string>("");
  const [statusChange, setStatusChange] = useState<"" | UnitStatus>("");

  const unit = units.find((u) => u.code === unitCode);

  const identifier = useMemo(
    () =>
      buildIdentifier({
        functionCode,
        type: unit?.type,
        eventTime: new Date(eventTime).toISOString(),
        strainCode: unit?.strainCode,
        unitCode: unit?.code,
      }),
    [functionCode, unit, eventTime],
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!unit) return toast.error("Select a unit");
    if (!title) return toast.error("Title required");
    dataActions.addEvent({
      functionCode,
      unitCode: unit.code,
      eventTime: new Date(eventTime).toISOString(),
      title,
      note: note || undefined,
      temperatureC: temperatureC ? parseFloat(temperatureC) : undefined,
      humidityRh: humidityRh ? parseFloat(humidityRh) : undefined,
      statusChange: statusChange || undefined,
    });
    toast.success("Event recorded");
    navigate({ to: "/units/$unitCode", params: { unitCode: unit.code } });
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h1 className="text-lg font-mono mb-3">Add event</h1>
      <Card className="bg-card border-border p-4">
        <form className="space-y-3" onSubmit={submit}>
          <Field label="Function">
            <select value={functionCode} onChange={(e) => setFunctionCode(e.target.value as FunctionCode)} className={selectCls}>
              {FUNCTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          <Field label="Unit">
            <select value={unitCode} onChange={(e) => setUnitCode(e.target.value)} className={selectCls}>
              <option value="">— select —</option>
              {units.map((u) => (
                <option key={u.code} value={u.code}>{u.code} ({u.type} #{u.strainCode})</option>
              ))}
            </select>
          </Field>
          <Field label="Event time">
            <Input type="datetime-local" value={eventTime} onChange={(e) => setEventTime(e.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Pinning started" />
          </Field>
          <Field label="Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Temperature °C">
              <Input type="number" step="0.1" value={temperatureC} onChange={(e) => setTemperatureC(e.target.value)} />
            </Field>
            <Field label="Humidity %RH">
              <Input type="number" step="1" value={humidityRh} onChange={(e) => setHumidityRh(e.target.value)} />
            </Field>
          </div>
          <Field label="Status change (optional)">
            <select value={statusChange} onChange={(e) => setStatusChange(e.target.value as UnitStatus | "")} className={selectCls}>
              {STATUSES.map((s) => <option key={s} value={s}>{s || "— no change —"}</option>)}
            </select>
          </Field>

          <div className="border-t border-border pt-3 space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Identifier preview</div>
            <IdentifierTag value={identifier} className="text-sm" />
          </div>

          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => navigate({ to: "/events" })}>Cancel</Button>
            <Button type="submit">Save event</Button>
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

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}