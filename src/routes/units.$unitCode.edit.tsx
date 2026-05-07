import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { ContainerType, UnitStatus } from "@/types";
import { toast } from "sonner";

export const Route = createFileRoute("/units/$unitCode/edit")({
  head: ({ params }) => ({ meta: [{ title: `Edit ${params.unitCode} — Myko Valvomo` }] }),
  component: EditUnit,
});

function EditUnit() {
  const { unitCode } = Route.useParams();
  const navigate = useNavigate();
  const { units, strains, taxonomy } = useDataStore();
  const TYPES = taxonomy.types as ContainerType[];
  const STATUSES = taxonomy.statuses as UnitStatus[];
  const unit = units.find((u) => u.code === unitCode);

  const [type, setType] = useState<ContainerType>(unit?.type ?? "BOX");
  const [strainCode, setStrainCode] = useState(unit?.strainCode ?? "");
  const [status, setStatus] = useState<UnitStatus>(unit?.status ?? "ACTIVE");
  const [batchTime, setBatchTime] = useState(unit ? toLocal(unit.batchTime) : toLocal(new Date().toISOString()));
  const [parentUnitCode, setParentUnitCode] = useState(unit?.parentUnitCode ?? "");
  const [substrate, setSubstrate] = useState(unit?.substrate ?? "");
  const [description, setDescription] = useState(unit?.description ?? "");
  const [notes, setNotes] = useState(unit?.notes ?? "");

  if (!unit) return <div className="p-4 text-sm">Unit not found.</div>;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    dataActions.updateUnit(unitCode, {
      type, strainCode, status,
      batchTime: new Date(batchTime).toISOString(),
      parentUnitCode: parentUnitCode || undefined,
      substrate: substrate.trim() || undefined,
      description: description || undefined,
      notes: notes || undefined,
    });
    toast.success("Unit updated");
    navigate({ to: "/units/$unitCode", params: { unitCode } });
  };

  const remove = () => {
    if (!confirm(`Delete unit ${unitCode}? Events and transfers remain.`)) return;
    dataActions.deleteUnit(unitCode);
    navigate({ to: "/units" });
  };

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-lg font-mono mb-3">Edit {unitCode}</h1>
      <Card className="p-4 bg-card border-border">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Container type (+TYPE)">
              <select value={type} onChange={(e) => setType(e.target.value as ContainerType)} className={selectCls}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Strain">
              <select value={strainCode} onChange={(e) => setStrainCode(e.target.value)} className={selectCls}>
                {strains.map((s) => <option key={s.code} value={s.code}>#{s.code}{s.description ? ` — ${s.description}` : ` — ${s.name}`}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as UnitStatus)} className={selectCls}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Batch time">
              <Input type="datetime-local" value={batchTime} onChange={(e) => setBatchTime(e.target.value)} className="font-mono text-xs" />
            </Field>
          </div>
          <Field label="Substrate / material">
            <Input value={substrate} onChange={(e) => setSubstrate(e.target.value.toUpperCase())} placeholder="e.g. BR, FCR, OAT, POPCORN, WBR" className="font-mono" />
          </Field>
          <Field label="Parent unit (optional)">
            <select value={parentUnitCode} onChange={(e) => setParentUnitCode(e.target.value)} className={selectCls}>
              <option value="">— none —</option>
              {units.filter((u) => u.code !== unitCode).map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}
            </select>
          </Field>
          <Field label="Description (shown in identifier)"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></Field>
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" onClick={remove} className="text-status-contaminated">Delete</Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => navigate({ to: "/units/$unitCode", params: { unitCode } })}>Cancel</Button>
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