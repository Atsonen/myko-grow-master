import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getDbState, updateStrain } from "@/lib/apiClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { Strain, Unit } from "@/types";
import { toast } from "sonner";

export const Route = createFileRoute("/strains/$code/edit")({
  head: ({ params }) => ({ meta: [{ title: `Edit ${normalizeCode(params.code)} - Myko Valvomo` }] }),
  component: EditStrain,
});

function EditStrain() {
  const params = Route.useParams();
  const originalCode = normalizeCode(params.code);
  const navigate = useNavigate();
  const [strain, setStrain] = useState<Strain | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [newCode, setNewCode] = useState(originalCode);
  const [name, setName] = useState("");
  const [species, setSpecies] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await getDbState();
        const found = data.strains.find((s) => normalizeCode(s.code) === originalCode);
        if (!found) throw new Error(`Strain #${originalCode} not found`);
        if (!cancelled) {
          setStrain(found);
          setUnits(data.units);
          setNewCode(found.code);
          setName(found.name);
          setSpecies(found.species);
          setDescription(found.description ?? "");
          setNotes(found.notes ?? "");
          setArchived(Boolean(found.archived));
          setStatus("ok");
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setError((err as Error).message);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [originalCode]);

  const affectedUnits = units.filter((u) => normalizeCode(u.strainCode) === originalCode).length;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedNewCode = normalizeCode(newCode);
    if (!normalizedNewCode) return toast.error("Strain code is required");
    if (!name.trim()) return toast.error("Name is required");
    if (!species.trim()) return toast.error("Species is required");

    setSaving(true);
    try {
      await updateStrain(originalCode, {
        code: normalizedNewCode,
        name: name.trim(),
        species: species.trim(),
        description: description.trim() || undefined,
        notes: notes.trim() || undefined,
        archived,
      });
      toast.success(originalCode === normalizedNewCode ? "Strain updated in MariaDB" : `Strain renamed to #${normalizedNewCode}`);
      navigate({ to: "/strains" });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") {
    return <div className="p-4 text-sm text-muted-foreground">Loading DB...</div>;
  }

  if (status === "error" || !strain) {
    return (
      <div className="p-4 text-sm space-y-3">
        <Card className="border-destructive/40 bg-destructive/10 p-3">
          <div className="font-medium">DB/API unavailable</div>
          <div className="text-xs text-muted-foreground mt-1">{error}</div>
        </Card>
        <Button variant="secondary" onClick={() => navigate({ to: "/strains" })}>Back to strains</Button>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-lg font-mono mb-3">Edit #{strain.code}</h1>
      <Card className="p-4 bg-card border-border">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Code">
            <Input value={newCode} onChange={(e) => setNewCode(normalizeCode(e.target.value))} className="font-mono" placeholder="GT" />
          </Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Species"><Input value={species} onChange={(e) => setSpecies(e.target.value)} /></Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></Field>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Archived
          </label>
          <div className="text-xs text-muted-foreground border border-border rounded p-3 bg-secondary/20">
            Renaming the code updates all units that currently use <span className="font-mono">#{strain.code}</span>. Affected units: <span className="font-mono">{affectedUnits}</span>.
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate({ to: "/strains" })}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save to MariaDB"}</Button>
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
