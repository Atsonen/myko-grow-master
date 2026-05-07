import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/strains/$code/edit")({
  head: ({ params }) => ({ meta: [{ title: `Edit ${normalizeCode(params.code)} — Myko Valvomo` }] }),
  component: EditStrain,
});

function EditStrain() {
  const params = Route.useParams();
  const originalCode = normalizeCode(params.code);
  const { strains } = useDataStore();
  const navigate = useNavigate();
  const strain = strains.find((s) => normalizeCode(s.code) === originalCode);
  const [newCode, setNewCode] = useState(strain?.code ?? originalCode);
  const [name, setName] = useState(strain?.name ?? "");
  const [species, setSpecies] = useState(strain?.species ?? "");
  const [description, setDescription] = useState(strain?.description ?? "");
  const [notes, setNotes] = useState(strain?.notes ?? "");

  if (!strain) {
    return (
      <div className="p-4 text-sm space-y-3">
        <div>Strain not found: <span className="font-mono">#{originalCode}</span></div>
        <Button variant="secondary" onClick={() => navigate({ to: "/strains" })}>Back to strains</Button>
      </div>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedNewCode = normalizeCode(newCode);
    if (!normalizedNewCode) return toast.error("Strain code is required");

    try {
      dataActions.renameStrain(strain.code, normalizedNewCode, {
        name,
        species,
        description: description || undefined,
        notes: notes || undefined,
      });
      toast.success(strain.code === normalizedNewCode ? "Strain updated" : `Strain renamed to #${normalizedNewCode}`);
      navigate({ to: "/strains" });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const affectedUnits = useDataStore().units.filter((u) => normalizeCode(u.strainCode) === normalizeCode(strain.code)).length;

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-lg font-mono mb-3">Edit #{strain.code}</h1>
      <Card className="p-4 bg-card border-border">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Code"><Input value={newCode} onChange={(e) => setNewCode(normalizeCode(e.target.value))} className="font-mono" placeholder="GT" /></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Species"><Input value={species} onChange={(e) => setSpecies(e.target.value)} /></Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></Field>
          <div className="text-xs text-muted-foreground border border-border rounded p-3 bg-secondary/20">
            Renaming the code updates all units that currently use <span className="font-mono">#{strain.code}</span>. Affected units: <span className="font-mono">{affectedUnits}</span>.
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate({ to: "/strains" })}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function normalizeCode(code: string) {
  return decodeURIComponent(code).replace(/^#+/, "").trim().toUpperCase();
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}