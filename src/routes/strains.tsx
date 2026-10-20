import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { createStrain, getStrains, getUnits } from "@/lib/apiClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { FlaskConical, Pencil } from "lucide-react";
import type { Strain, Unit } from "@/types";

export const Route = createFileRoute("/strains")({
  head: () => ({ meta: [{ title: "Strains - Myko Valvomo" }] }),
  component: StrainsLayout,
});

function StrainsLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isChild = path !== "/strains";

  return (
    <div className="p-4 space-y-4 max-w-4xl">
      {!isChild && <StrainsIndex />}
      <Outlet />
    </div>
  );
}

function StrainsIndex() {
  const [strains, setStrains] = useState<Strain[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [apiStatus, setApiStatus] = useState<"loading" | "ok" | "error">("loading");
  const [apiError, setApiError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showNewStrainForm, setShowNewStrainForm] = useState(false);
  const [newStrainCode, setNewStrainCode] = useState("");
  const [newStrainName, setNewStrainName] = useState("");
  const [newStrainSpecies, setNewStrainSpecies] = useState("");
  const [newStrainDescription, setNewStrainDescription] = useState("");
  const [newStrainNotes, setNewStrainNotes] = useState("");
  const [creatingStrain, setCreatingStrain] = useState(false);

  const load = async (cancelled?: () => boolean) => {
    try {
      const [loadedStrains, loadedUnits] = await Promise.all([getStrains(), getUnits()]);
      if (!cancelled?.()) {
        setStrains(loadedStrains);
        setUnits(loadedUnits);
        setApiStatus("ok");
        setApiError("");
      }
    } catch (error) {
      if (!cancelled?.()) {
        setApiStatus("error");
        setApiError((error as Error).message);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleStrains = strains.filter((s) => showArchived || !s.archived);
  const hiddenCount = strains.filter((s) => s.archived).length;

  const resetNewStrainForm = () => {
    setNewStrainCode("");
    setNewStrainName("");
    setNewStrainSpecies("");
    setNewStrainDescription("");
    setNewStrainNotes("");
  };

  const handleCreateStrain = async (event: FormEvent) => {
    event.preventDefault();
    const code = normalizeCode(newStrainCode);
    if (!code) return toast.error("Strain code is required");
    if (!newStrainName.trim()) return toast.error("Strain name is required");
    if (!newStrainSpecies.trim()) return toast.error("Species is required");

    setCreatingStrain(true);
    try {
      await createStrain({
        code,
        name: newStrainName.trim(),
        species: newStrainSpecies.trim(),
        description: newStrainDescription.trim() || undefined,
        notes: newStrainNotes.trim() || undefined,
        archived: false,
      });
      toast.success(`Created strain #${code}`);
      setShowNewStrainForm(false);
      resetNewStrainForm();
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setCreatingStrain(false);
    }
  };

  return (
    <>
      {apiStatus === "error" && <DbError message={apiError} />}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-mono flex items-center gap-2">
          <FlaskConical className="h-4 w-4" /> Strains
        </h1>
        <Button size="sm" variant="secondary" onClick={() => setShowNewStrainForm((prev) => !prev)}>
          {showNewStrainForm ? "Hide new strain" : "Add new strain"}
        </Button>
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
          {apiStatus === "loading"
            ? "Loading DB..."
            : `${visibleStrains.length} / ${strains.length}${!showArchived ? ` (${hiddenCount} archived hidden)` : ""}`}
        </span>
      </div>
      {showNewStrainForm ? (
        <Card className="p-4 bg-card border-border space-y-3">
          <div className="text-sm font-medium">Create new strain</div>
          <form onSubmit={handleCreateStrain} className="space-y-3">
            <Field label="Code">
              <Input
                value={newStrainCode}
                onChange={(e) => setNewStrainCode(e.target.value)}
                className="font-mono"
                placeholder="GT"
              />
            </Field>
            <Field label="Name">
              <Input value={newStrainName} onChange={(e) => setNewStrainName(e.target.value)} />
            </Field>
            <Field label="Species">
              <Input
                value={newStrainSpecies}
                onChange={(e) => setNewStrainSpecies(e.target.value)}
              />
            </Field>
            <Field label="Description">
              <Textarea
                value={newStrainDescription}
                onChange={(e) => setNewStrainDescription(e.target.value)}
                rows={2}
              />
            </Field>
            <Field label="Notes">
              <Textarea
                value={newStrainNotes}
                onChange={(e) => setNewStrainNotes(e.target.value)}
                rows={2}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={creatingStrain}>
                {creatingStrain ? "Saving..." : "Create strain"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowNewStrainForm(false);
                  resetNewStrainForm();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card className="p-4 bg-card border-border space-y-2">
        {apiStatus === "loading" && (
          <div className="text-xs text-muted-foreground italic">Loading DB...</div>
        )}
        {visibleStrains.map((s) => {
          const count = units.filter(
            (u) => u.strainCode === s.code && (showArchived || u.status !== "ARCHIVED"),
          ).length;
          return (
            <div
              key={s.code}
              className={`flex items-start gap-3 border rounded p-3 bg-secondary/20 ${s.archived ? "border-status-archived/60 opacity-70" : "border-border"}`}
            >
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm">
                  #{s.code} <span className="text-muted-foreground">- {s.name}</span>
                  {s.archived ? (
                    <span className="ml-2 text-[10px] text-status-archived">ARCHIVED</span>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground italic">{s.species}</div>
                {s.description && <div className="text-xs mt-1">{s.description}</div>}
                <div className="text-[10px] font-mono text-muted-foreground mt-1">
                  {count} visible units
                </div>
              </div>
              <Button size="sm" variant="secondary" asChild title="Edit strain in MariaDB">
                <Link to="/strains/$code/edit" params={{ code: s.code }}>
                  <Pencil className="h-3 w-3" />
                </Link>
              </Button>
            </div>
          );
        })}
        {apiStatus !== "loading" && visibleStrains.length === 0 && (
          <div className="text-xs text-muted-foreground italic">
            {apiStatus === "error" ? "DB/API unavailable." : "No strains."}
          </div>
        )}
      </Card>
    </>
  );
}

function normalizeCode(code: string) {
  return code.replace(/^#+/, "").trim().toUpperCase();
}

function DbError({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40 bg-destructive/10 p-3">
      <div className="text-sm font-medium">DB/API unavailable</div>
      <div className="text-xs text-muted-foreground mt-1">{message}</div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
