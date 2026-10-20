import { ORIGIN_TYPES, type OriginInput, type OriginType } from "@/lib/traceApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const sel = "h-8 rounded-md border border-input bg-background px-2 text-xs font-mono";

/** Edit a list of origins: parent unit(s) and/or non-unit sources (spores, purchased, ...). */
export function OriginEditor({ value, onChange, unitCodes, exclude }: {
  value: OriginInput[]; onChange: (v: OriginInput[]) => void; unitCodes: string[]; exclude?: string[];
}) {
  const set = (i: number, patch: Partial<OriginInput>) => onChange(value.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const options = unitCodes.filter((c) => !exclude?.includes(c));
  return (
    <div className="space-y-2" data-testid="origin-editor">
      {value.length === 0 && <div className="text-[11px] text-muted-foreground">No origin set.</div>}
      {value.map((o, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select aria-label="Origin type" className={sel} value={o.type}
            onChange={(e) => set(i, { type: e.target.value as OriginType, parentUnitCode: e.target.value === "UNIT" ? o.parentUnitCode : undefined })}>
            {ORIGIN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {o.type === "UNIT" ? (
            <>
              <Input aria-label="Parent unit" list="origin-unit-codes" className="h-8 w-48 font-mono text-xs" placeholder="parent unit code"
                value={o.parentUnitCode ?? ""} onChange={(e) => set(i, { parentUnitCode: e.target.value.toUpperCase() })} />
            </>
          ) : null}
          <Input aria-label="Origin note" className="h-8 w-56 text-xs" placeholder="note (e.g. vendor, print id)" value={o.note ?? ""}
            onChange={(e) => set(i, { note: e.target.value })} />
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...value, { type: "UNIT" }])}>+ Parent unit</Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...value, { type: "SPORES" }])}>+ Other source</Button>
      </div>
      <datalist id="origin-unit-codes">{options.map((c) => <option key={c} value={c} />)}</datalist>
    </div>
  );
}

export const cleanOrigins = (v: OriginInput[]) =>
  v.filter((o) => o.type !== "UNIT" || o.parentUnitCode?.trim()).map((o) => ({ ...o, note: o.note?.trim() || undefined, parentUnitCode: o.parentUnitCode?.trim() || undefined }));
