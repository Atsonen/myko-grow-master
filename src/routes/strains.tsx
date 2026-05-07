import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Archive, ArchiveRestore, FlaskConical, Pencil, Trash2 } from "lucide-react";

export const Route = createFileRoute("/strains")({
  head: () => ({ meta: [{ title: "Strains — Myko Valvomo" }] }),
  component: StrainsPage,
});

function StrainsPage() {
  const { strains, units } = useDataStore();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [species, setSpecies] = useState("");
  const [description, setDescription] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const visibleStrains = strains.filter((s) => showArchived || !s.archived);
  const hiddenCount = strains.filter((s) => s.archived).length;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || !name) return toast.error("Code and name required");
    if (strains.some((s) => s.code === code.toUpperCase())) return toast.error("Code already exists");
    dataActions.addStrain({ code: code.toUpperCase(), name, species, description: description || undefined });
    toast.success("Strain added");
    setCode(""); setName(""); setSpecies(""); setDescription("");
  };

  const remove = (c: string) => {
    if (units.some((u) => u.strainCode === c)) return toast.error("Strain in use by units");
    if (!confirm(`Delete strain ${c}?`)) return;
    dataActions.deleteStrain(c);
  };

  const toggleArchive = (c: string, archived?: boolean) => {
    if (archived) {
      dataActions.restoreStrain(c);
      toast.success("Strain restored");
    } else {
      dataActions.archiveStrain(c);
      toast.success("Strain archived");
    }
  };

  return (
    <div className="p-4 space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-mono flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Strains</h1>
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">{visibleStrains.length} / {strains.length}{!showArchived ? ` (${hiddenCount} archived hidden)` : ""}</span>
      </div>
      <Card className="p-4 bg-card border-border space-y-2">
        {visibleStrains.map((s) => {
          const count = units.filter((u) => u.strainCode === s.code && (showArchived || u.status !== "ARCHIVED")).length;
          return (
            <div key={s.code} className={`flex items-start gap-3 border rounded p-3 bg-secondary/20 ${s.archived ? "border-status-archived/60 opacity-70" : "border-border"}`}>
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm">#{s.code} <span className="text-muted-foreground">— {s.name}</span>{s.archived ? <span className="ml-2 text-[10px] text-status-archived">ARCHIVED</span> : null}</div>
                <div className="text-xs text-muted-foreground italic">{s.species}</div>
                {s.description && <div className="text-xs mt-1">{s.description}</div>}
                <div className="text-[10px] font-mono text-muted-foreground mt-1">{count} visible units</div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => toggleArchive(s.code, s.archived)}>
                {s.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => navigate({ to: "/strains/$code/edit", params: { code: s.code } })}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove(s.code)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        })}
      </Card>

      <Card className="p-4 bg-card border-border">
        <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-3">New strain</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="OST" className="font-mono" /></Field>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pearl Oyster" /></Field>
          </div>
          <Field label="Species"><Input value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="Pleurotus ostreatus" /></Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
          <div className="flex justify-end"><Button type="submit">Add strain</Button></div>
        </form>
      </Card>

      <div><Link to="/lineage/graph" className="text-xs text-primary hover:underline">→ View lineage graph</Link></div>
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