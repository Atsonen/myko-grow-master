import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/transfers/$transferId/edit")({
  head: () => ({ meta: [{ title: "Edit transfer — Myko Valvomo" }] }),
  component: EditTransfer,
});

function EditTransfer() {
  const { transferId } = Route.useParams();
  const navigate = useNavigate();
  const { transfers, units } = useDataStore();
  const t = transfers.find((x) => x.id === transferId);

  const [sourceUnitCode, setSource] = useState(t?.sourceUnitCode ?? "");
  const [targetUnitCode, setTarget] = useState(t?.targetUnitCode ?? "");
  const [transferTime, setTime] = useState(t ? toLocal(t.transferTime) : toLocal(new Date().toISOString()));
  const [method, setMethod] = useState(t?.method ?? "");
  const [amount, setAmount] = useState(t?.amount ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [note, setNote] = useState(t?.note ?? "");

  if (!t) return <div className="p-4 text-sm">Transfer not found.</div>;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    dataActions.updateTransfer(transferId, {
      sourceUnitCode, targetUnitCode,
      transferTime: new Date(transferTime).toISOString(),
      method, amount,
      description: description || undefined,
      note: note || undefined,
    });
    toast.success("Transfer updated");
    navigate({ to: "/transfers" });
  };

  const remove = () => {
    if (!confirm("Delete this transfer?")) return;
    dataActions.deleteTransfer(transferId);
    navigate({ to: "/transfers" });
  };

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-lg font-mono mb-3">Edit transfer</h1>
      <Card className="p-4 bg-card border-border">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Source"><select value={sourceUnitCode} onChange={(e) => setSource(e.target.value)} className={selectCls}>{units.map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}</select></Field>
            <Field label="Target"><select value={targetUnitCode} onChange={(e) => setTarget(e.target.value)} className={selectCls}>{units.map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}</select></Field>
          </div>
          <Field label="Transfer time"><Input type="datetime-local" value={transferTime} onChange={(e) => setTime(e.target.value)} className="font-mono text-xs" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Method"><Input value={method} onChange={(e) => setMethod(e.target.value)} /></Field>
            <Field label="Amount"><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          </div>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
          <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} /></Field>
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" onClick={remove} className="text-status-contaminated">Delete</Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => navigate({ to: "/transfers" })}>Cancel</Button>
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