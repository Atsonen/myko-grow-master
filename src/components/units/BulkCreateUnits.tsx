import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { KNOWN_LOCATIONS } from "@/lib/locations";
import { bulkCreateUnits, type OriginInput } from "@/lib/traceApi";
import { OriginEditor, cleanOrigins } from "./OriginEditor";
import type { Strain, Unit } from "@/types";

const sel = "h-8 rounded-md border border-input bg-background px-2 text-xs font-mono";
const SUB_TOKENS: Record<string, string> = { FCR: "FCR", OAT: "OAT", BR: "BR", GS: "GRAIN", RIS: "RICE" };

/** Create N units "YYMMDD-TYPE-n" with automatic sequence numbers continuing after the existing max. */
export function BulkCreateUnits({ units, strains, onDone }: { units: Unit[]; strains: Strain[]; onDone: (codes: string[]) => Promise<void> | void }) {
  const [base, setBase] = useState("");
  const [count, setCount] = useState(1);
  const [strain, setStrain] = useState("");
  const [location, setLocation] = useState("");
  const [batchTime, setBatchTime] = useState("");
  const [substrate, setSubstrate] = useState("");
  const [notes, setNotes] = useState("");
  const [origins, setOrigins] = useState<OriginInput[]>([]);
  const [busy, setBusy] = useState(false);

  const b = base.trim().toUpperCase();
  const m = /^(\d{6})-([A-Z]+)$/.exec(b);
  const token = m ? (SUB_TOKENS[m[2]] ? "JAR" : m[2]) : "";
  const prefix = m ? `${m[1]}-${token}-` : "";
  const max = units.reduce((acc, u) => { const x = prefix && u.code.startsWith(prefix) ? /^(\d+)$/.exec(u.code.slice(prefix.length)) : null; return x ? Math.max(acc, +x[1]) : acc; }, 0);
  const preview = m && count > 0 ? `${prefix}${max + 1}${count > 1 ? ` … ${prefix}${max + count}` : ""}` : "enter base like 261013-JAR or 261013-FCR";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!m) return toast.error("Base must be YYMMDD-TYPE, e.g. 261013-JAR");
    setBusy(true);
    try {
      const r = await bulkCreateUnits({ base: b, count, strainCode: strain || undefined, location: location || undefined,
        batchTime: batchTime ? new Date(batchTime).toISOString() : undefined, substrate: substrate || undefined,
        notes: notes.trim() || undefined, origins: cleanOrigins(origins) });
      toast.success(`Created ${r.codes.length} units: ${r.codes[0]}${r.codes.length > 1 ? ` … ${r.codes[r.codes.length - 1]}` : ""}`);
      await onDone(r.codes);
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <Card className="p-4 bg-card border-border space-y-3" data-testid="bulk-create">
      <div className="text-sm font-medium">Create units (bulk)</div>
      <form onSubmit={submit} className="space-y-3 text-xs">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1"><div className="text-[10px] uppercase text-muted-foreground">Code base</div>
            <Input aria-label="Code base" className="h-8 w-40 font-mono" placeholder="261013-JAR" value={base} onChange={(e) => setBase(e.target.value.toUpperCase())} /></label>
          <label className="space-y-1"><div className="text-[10px] uppercase text-muted-foreground">Count</div>
            <Input aria-label="Count" type="number" min={1} max={200} className="h-8 w-20" value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} /></label>
          <label className="space-y-1"><div className="text-[10px] uppercase text-muted-foreground">Strain</div>
            <select aria-label="Strain" className={sel} value={strain} onChange={(e) => setStrain(e.target.value)}>
              <option value="">inherit from parent / none</option>
              {strains.filter((s) => !s.archived).map((s) => <option key={s.code} value={s.code}>#{s.code} {s.name}</option>)}
            </select></label>
          <label className="space-y-1"><div className="text-[10px] uppercase text-muted-foreground">Location</div>
            <select aria-label="Location" className={sel} value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">not set</option>{KNOWN_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select></label>
          <label className="space-y-1"><div className="text-[10px] uppercase text-muted-foreground">Batch time (default 12:00 of code date)</div>
            <Input aria-label="Batch time" type="datetime-local" className="h-8 w-48 font-mono" value={batchTime} onChange={(e) => setBatchTime(e.target.value)} /></label>
          <label className="space-y-1"><div className="text-[10px] uppercase text-muted-foreground">Substrate</div>
            <Input aria-label="Substrate" className="h-8 w-28 font-mono" placeholder={m && SUB_TOKENS[m[2]] ? SUB_TOKENS[m[2]] : "optional"} value={substrate} onChange={(e) => setSubstrate(e.target.value.toUpperCase())} /></label>
        </div>
        <div><div className="text-[10px] uppercase text-muted-foreground mb-1">Origin (applies to all)</div>
          <OriginEditor value={origins} onChange={setOrigins} unitCodes={units.map((u) => u.code)} /></div>
        <Input aria-label="Notes" className="h-8 text-xs" placeholder="notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="flex items-center gap-3">
          <Button size="sm" type="submit" disabled={busy || !m}>Create {count} unit{count > 1 ? "s" : ""}</Button>
          <span className="font-mono text-[11px] text-muted-foreground" data-testid="bulk-create-preview">{preview}</span>
        </div>
      </form>
    </Card>
  );
}
