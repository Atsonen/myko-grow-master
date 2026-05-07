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
import type { ContainerType } from "@/types";
import { toast } from "sonner";

const TYPES: ContainerType[] = ["BOX", "JAR", "PD", "LC", "BAG", "OTHER"];

const searchSchema = z.object({
  source: z.string().optional(),
});

export const Route = createFileRoute("/transfers/new")({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Add transfer — Myko Valvomo" }] }),
  component: AddTransferPage,
});

function AddTransferPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { units } = useDataStore();

  const [sourceUnitCode, setSourceUnitCode] = useState(search.source ?? units[0]?.code ?? "");
  const [targetMode, setTargetMode] = useState<"existing" | "new">("new");
  const [existingTarget, setExistingTarget] = useState("");
  const [newTargetCode, setNewTargetCode] = useState("");
  const [newTargetType, setNewTargetType] = useState<ContainerType>("BOX");
  const [transferTime, setTransferTime] = useState(toLocalInput(new Date()));
  const [method, setMethod] = useState("spawn to bulk");
  const [amount, setAmount] = useState("1 unit");
  const [note, setNote] = useState("");

  const source = units.find((u) => u.code === sourceUnitCode);
  const targetUnitCode = targetMode === "existing" ? existingTarget : newTargetCode;
  const target = units.find((u) => u.code === targetUnitCode);
  const targetType = target?.type ?? newTargetType;
  const strainCode = target?.strainCode ?? source?.strainCode ?? "UNK";

  const identifier = useMemo(
    () =>
      buildIdentifier({
        functionCode: "TRF",
        type: targetType,
        eventTime: new Date(transferTime).toISOString(),
        strainCode,
        unitCode: targetUnitCode || "NEW-UNIT",
      }),
    [targetType, transferTime, strainCode, targetUnitCode],
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!source) return toast.error("Select source unit");
    if (!targetUnitCode) return toast.error("Define target unit");
    if (targetMode === "new" && units.some((u) => u.code === newTargetCode)) return toast.error("Target unit already exists");

    dataActions.addTransfer({
      sourceUnitCode: source.code,
      targetUnitCode,
      transferTime: new Date(transferTime).toISOString(),
      method,
      amount,
      note: note || undefined,
      targetUnit:
        targetMode === "new"
          ? {
              code: targetUnitCode,
              type: newTargetType,
              strainCode: source.strainCode,
              notes: `Created from transfer ${source.code} → ${targetUnitCode}`,
            }
          : undefined,
    });

    toast.success("Transfer recorded");
    navigate({ to: "/units/$unitCode", params: { unitCode: targetUnitCode } });
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h1 className="text-lg font-mono mb-3">Add transfer</h1>
      <Card className="bg-card border-border p-4">
        <form className="space-y-3" onSubmit={submit}>
          <Field label="Source unit">
            <select value={sourceUnitCode} onChange={(e) => setSourceUnitCode(e.target.value)} className={selectCls}>
              <option value="">— select —</option>
              {units.map((u) => (
                <option key={u.code} value={u.code}>{u.code} ({u.type} #{u.strainCode})</option>
              ))}
            </select>
          </Field>

          <Field label="Target mode">
            <div className="flex gap-2">
              <Button type="button" variant={targetMode === "new" ? "default" : "secondary"} onClick={() => setTargetMode("new")}>Create new target</Button>
              <Button type="button" variant={targetMode === "existing" ? "default" : "secondary"} onClick={() => setTargetMode("existing")}>Use existing target</Button>
            </div>
          </Field>

          {targetMode === "existing" ? (
            <Field label="Target unit">
              <select value={existingTarget} onChange={(e) => setExistingTarget(e.target.value)} className={selectCls}>
                <option value="">— select —</option>
                {units.map((u) => (
                  <option key={u.code} value={u.code}>{u.code} ({u.type} #{u.strainCode})</option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="New target unit code">
                <Input value={newTargetCode} onChange={(e) => setNewTargetCode(e.target.value)} placeholder="e.g. BOX-260507-1" className="font-mono" />
              </Field>
              <Field label="New target type">
                <select value={newTargetType} onChange={(e) => setNewTargetType(e.target.value as ContainerType)} className={selectCls}>
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            </div>
          )}

          <Field label="Transfer time">
            <Input type="datetime-local" value={transferTime} onChange={(e) => setTransferTime(e.target.value)} className="font-mono text-xs" />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Method">
              <Input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="e.g. LC to jar" />
            </Field>
            <Field label="Amount">
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 3 ml" />
            </Field>
          </div>
          <Field label="Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </Field>

          <div className="border-t border-border pt-3 space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Transfer identifier preview</div>
            <IdentifierTag value={identifier} className="text-sm" />
          </div>

          <div className="text-xs text-muted-foreground border border-border rounded p-3 bg-secondary/20">
            Transfer is stored as a structured relation: source unit → target unit. This is what makes lineage reliable; it does not depend on free-text notes like “INO LC-16”.
          </div>

          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => navigate({ to: "/lineage" })}>Cancel</Button>
            <Button type="submit">Save transfer</Button>
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
