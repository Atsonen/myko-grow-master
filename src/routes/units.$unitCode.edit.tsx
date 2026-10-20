import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getStrains, getTaxonomy, getUnits, updateUnit } from "@/lib/apiClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { ContainerType, Strain, Unit, UnitStatus } from "@/types";
import type { Taxonomy } from "@/store/useDataStore";
import { toast } from "sonner";

export const Route = createFileRoute("/units/$unitCode/edit")({
  head: ({ params }) => ({ meta: [{ title: `Edit ${params.unitCode} - Myko Valvomo` }] }),
  component: EditUnit,
});

function EditUnit() {
  const { unitCode } = Route.useParams();
  const navigate = useNavigate();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [strains, setStrains] = useState<Strain[]>([]);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>({
    functions: [],
    types: [],
    statuses: [],
    qcTags: [],
  });
  const [apiStatus, setApiStatus] = useState<"loading" | "ok" | "error">("loading");
  const [apiError, setApiError] = useState("");
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<ContainerType>("BOX");
  const [strainCode, setStrainCode] = useState("");
  const [status, setStatus] = useState<UnitStatus>("ACTIVE");
  const [batchTime, setBatchTime] = useState(toLocal(new Date().toISOString()));
  const [parentUnitCode, setParentUnitCode] = useState("");
  const [substrate, setSubstrate] = useState("");
  const [currentLocation, setCurrentLocation] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [loadedUnits, loadedStrains, loadedTaxonomy] = await Promise.all([
          getUnits(),
          getStrains(),
          getTaxonomy(),
        ]);
        const found = loadedUnits.find((u) => u.code === unitCode);
        if (!found) throw new Error(`Unit ${unitCode} not found`);
        if (!cancelled) {
          setUnit(found);
          setUnits(loadedUnits);
          setStrains(loadedStrains);
          setTaxonomy(loadedTaxonomy);
          setType(found.type);
          setStrainCode(found.strainCode ?? "");
          setStatus(found.status);
          setBatchTime(toLocal(found.batchTime));
          setParentUnitCode(found.parentUnitCode ?? "");
          setSubstrate(found.substrate ?? "");
          setCurrentLocation(found.currentLocation ?? "");
          setDescription(found.description ?? "");
          setNotes(found.notes ?? "");
          setApiStatus("ok");
          setApiError("");
        }
      } catch (error) {
        if (!cancelled) {
          setApiStatus("error");
          setApiError((error as Error).message);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [unitCode]);

  const TYPES = taxonomy.types as ContainerType[];
  const STATUSES = taxonomy.statuses as UnitStatus[];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unit) return;
    setSaving(true);
    try {
      await updateUnit(unitCode, {
        code: unitCode,
        type,
        strainCode,
        status,
        batchTime: new Date(batchTime).toISOString(),
        parentUnitCode: parentUnitCode || undefined,
        substrate: substrate.trim() || undefined,
        currentLocation: currentLocation.trim() || undefined,
        description: description.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success("Unit updated in MariaDB");
      navigate({ to: "/units" });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (apiStatus === "loading")
    return <div className="p-4 text-sm text-muted-foreground">Loading DB...</div>;

  if (apiStatus === "error" || !unit) {
    return (
      <div className="p-4 text-sm space-y-3">
        <Card className="border-destructive/40 bg-destructive/10 p-3">
          <div className="font-medium">DB/API unavailable</div>
          <div className="text-xs text-muted-foreground mt-1">{apiError}</div>
        </Card>
        <Button variant="secondary" onClick={() => navigate({ to: "/units" })}>
          Back to units
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-lg font-mono mb-3">Edit {unitCode}</h1>
      <Card className="p-4 bg-card border-border">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Container type (+TYPE)">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ContainerType)}
                className={selectCls}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Strain">
              <select
                value={strainCode}
                onChange={(e) => setStrainCode(e.target.value)}
                className={selectCls}
              >
                <option value="">— no strain —</option>
                {strains.map((s) => (
                  <option key={s.code} value={s.code}>
                    #{s.code} - {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as UnitStatus)}
                className={selectCls}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Batch time">
              <Input
                type="datetime-local"
                value={batchTime}
                onChange={(e) => setBatchTime(e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
          </div>
          <Field label="Substrate / material">
            <Input
              value={substrate}
              onChange={(e) => setSubstrate(e.target.value.toUpperCase())}
              placeholder="e.g. BR, FCR, OAT, POPCORN, WBR"
              className="font-mono"
            />
          </Field>
          <Field label="Current location">
            <Input
              value={currentLocation}
              onChange={(e) => setCurrentLocation(e.target.value.toUpperCase())}
              placeholder="e.g. INCUBATOR-1"
              className="font-mono"
            />
          </Field>
          <Field label="Parent unit (optional)">
            <select
              value={parentUnitCode}
              onChange={(e) => setParentUnitCode(e.target.value)}
              className={selectCls}
            >
              <option value="">none</option>
              {units
                .filter((u) => u.code !== unitCode)
                .map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.code}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Description (shown in identifier)">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </Field>
          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate({ to: "/units" })}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save to MariaDB"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

const selectCls =
  "h-9 w-full bg-input text-foreground border border-border rounded px-2 text-sm font-mono";

function toLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
