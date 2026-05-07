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
  head: ({ params }) => ({ meta: [{ title: `Edit ${params.code} — Myko Valvomo` }] }),
  component: EditStrain,
});

function EditStrain() {
  const { code } = Route.useParams();
  const { strains } = useDataStore();
  const navigate = useNavigate();
  const strain = strains.find((s) => s.code === code);
  const [name, setName] = useState(strain?.name ?? "");
  const [species, setSpecies] = useState(strain?.species ?? "");
  const [description, setDescription] = useState(strain?.description ?? "");
  const [notes, setNotes] = useState(strain?.notes ?? "");

  if (!strain) return <div className="p-4 text-sm">Strain not found.</div>;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    dataActions.updateStrain(code, { name, species, description: description || undefined, notes: notes || undefined });
    toast.success("Strain updated");
    navigate({ to: "/strains" });
  };

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-lg font-mono mb-3">Edit #{code}</h1>
      <Card className="p-4 bg-card border-border">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Species"><Input value={species} onChange={(e) => setSpecies(e.target.value)} /></Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate({ to: "/strains" })}>Cancel</Button>
            <Button type="submit">Save</Button>
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