import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useDataStore, dataActions, type Taxonomy } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2, Plus, Check, X, Tag } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/taxonomy")({
  head: () => ({ meta: [{ title: "Taxonomy / Tags — Myko Valvomo" }] }),
  component: TaxonomyPage,
});

const SECTIONS: { key: keyof Taxonomy; title: string; help: string }[] = [
  { key: "functions", title: "Functions", help: "Process aspect codes (=FUNCTION). E.g. COL, FRU, OBS, QC, TRF, HAR, PREP." },
  { key: "types", title: "Container types", help: "Unit types (+TYPE). E.g. BOX, JAR, PD, LC, BAG, OTHER." },
  { key: "statuses", title: "Unit statuses", help: "Lifecycle states. E.g. ACTIVE, CONTAMINATED, HARVESTED." },
  { key: "qcTags", title: "QC tags", help: "Contamination / risk tags applied to QC events." },
];

function TaxonomyPage() {
  const { taxonomy } = useDataStore();
  return (
    <div className="p-4 space-y-4 max-w-4xl">
      <div>
        <h1 className="text-lg font-mono flex items-center gap-2"><Tag className="h-4 w-4" /> Taxonomy / Tags</h1>
        <p className="text-xs text-muted-foreground mt-1">Add, rename, or delete the tag values used across the app. Tags currently in use cannot be deleted but can be renamed.</p>
      </div>
      {SECTIONS.map((s) => (
        <Section key={s.key} categoryKey={s.key} title={s.title} help={s.help} values={taxonomy[s.key]} />
      ))}
    </div>
  );
}

function Section({ categoryKey, title, help, values }: { categoryKey: keyof Taxonomy; title: string; help: string; values: string[] }) {
  const [newVal, setNewVal] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVal.trim()) return;
    dataActions.addTag(categoryKey, newVal);
    setNewVal("");
    toast.success("Tag added");
  };

  const startEdit = (v: string) => { setEditing(v); setEditVal(v); };
  const saveEdit = (v: string) => {
    dataActions.renameTag(categoryKey, v, editVal);
    setEditing(null);
    toast.success("Tag renamed");
  };
  const remove = (v: string) => {
    if (!confirm(`Delete tag "${v}"?`)) return;
    try {
      dataActions.removeTag(categoryKey, v);
      toast.success("Tag deleted");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Card className="p-4 bg-card border-border space-y-3">
      <div>
        <h2 className="text-sm font-mono uppercase tracking-wider">{title}</h2>
        <p className="text-[11px] text-muted-foreground">{help}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => (
          <div key={v} className="inline-flex items-center gap-1 border border-border rounded bg-secondary/30 pl-2 pr-1 py-0.5">
            {editing === v ? (
              <>
                <Input value={editVal} onChange={(e) => setEditVal(e.target.value)} className="h-6 w-24 font-mono text-xs" />
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => saveEdit(v)}><Check className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => setEditing(null)}><X className="h-3 w-3" /></Button>
              </>
            ) : (
              <>
                <span className="font-mono text-xs">{v}</span>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => startEdit(v)}><Pencil className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => remove(v)}><Trash2 className="h-3 w-3" /></Button>
              </>
            )}
          </div>
        ))}
        {values.length === 0 && <span className="text-xs italic text-muted-foreground">No tags.</span>}
      </div>
      <form onSubmit={add} className="flex gap-2">
        <Input value={newVal} onChange={(e) => setNewVal(e.target.value)} placeholder="NEW_TAG" className="h-8 max-w-[200px] font-mono text-xs uppercase" />
        <Button type="submit" size="sm"><Plus className="h-3 w-3 mr-1" /> Add</Button>
      </form>
    </Card>
  );
}