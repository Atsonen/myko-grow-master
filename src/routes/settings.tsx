import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Settings, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  updateDataloggerVariable,
  type DataloggerVariable,
  type DataloggerVariableType,
  type StatusBitDef,
} from "@/lib/apiClient";
import { BIT_OFF_DEFAULT, BIT_ON_DEFAULT, reloadDataloggerVariables, useDataloggerVariables } from "@/lib/statusBits";
import { SERIES_COLORS, useSeriesDefaults } from "@/lib/seriesStyle";
import { MykoPlcSettings } from "@/components/settings/MykoPlcSettings";
import { AiProcessSettings } from "@/components/settings/AiProcessSettings";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — Myko Valvomo" }] }),
  component: SettingsPage,
});

const inp = "h-8 rounded border border-input bg-background px-2 text-xs font-mono";

function SettingsPage() {
  const variables = useDataloggerVariables();
  return (
    <div className="p-4 space-y-4 max-w-6xl">
      <div>
        <h1 className="text-lg font-mono flex items-center gap-2"><Settings className="h-4 w-4" /> Settings</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Datalogger variables (MQTT topic <span className="font-mono">Datalogger/</span>, index 0–39). Analog values appear in
          trend pickers when visible; status words are bit fields shown with the “Status bits” dashboard widget; unused indices
          are hidden everywhere. Default color applies to every trend view unless a view overrides it.
        </p>
      </div>
      <MykoPlcSettings />
      <AiProcessSettings />
      <Card className="p-0 overflow-x-auto">
        <table className="w-full text-xs" data-testid="dl-settings">
          <thead className="text-[10px] uppercase text-muted-foreground font-mono">
            <tr className="border-b border-border">
              <th className="p-2 text-left">Key</th>
              <th className="p-2 text-left">Sheet name</th>
              <th className="p-2 text-left">Display name</th>
              <th className="p-2 text-left">Type</th>
              <th className="p-2 text-left">Unit</th>
              <th className="p-2 text-left">Scale</th>
              <th className="p-2 text-left">Trends</th>
              <th className="p-2 text-left">Color</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {variables.map((v) => (
              <VariableRow key={v.variableKey} v={v} />
            ))}
          </tbody>
        </table>
        {variables.length === 0 && <div className="p-4 text-xs text-muted-foreground">Loading…</div>}
      </Card>
    </div>
  );
}

function VariableRow({ v }: { v: DataloggerVariable }) {
  const seriesId = `dl:${v.sourceId}:${v.variableKey}`;
  const { defaults, save: saveDefault } = useSeriesDefaults();
  const [displayName, setDisplayName] = useState(v.displayName ?? "");
  const [type, setType] = useState<DataloggerVariableType>(v.type);
  const [unit, setUnit] = useState(v.unit);
  const [scale, setScale] = useState(String(v.scale));
  const [visible, setVisible] = useState(v.visible);
  const [color, setColor] = useState(defaults[seriesId]?.color ?? "");
  const [bits, setBits] = useState<StatusBitDef[]>(v.bits);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setColor(defaults[seriesId]?.color ?? ""), [defaults, seriesId]);
  useEffect(() => {
    setDisplayName(v.displayName ?? ""); setType(v.type); setUnit(v.unit); setScale(String(v.scale));
    setVisible(v.visible); setBits(v.bits);
  }, [v]);

  const dirty =
    displayName !== (v.displayName ?? "") || type !== v.type || unit !== v.unit || Number(scale) !== v.scale ||
    visible !== v.visible || color !== (defaults[seriesId]?.color ?? "") || JSON.stringify(bits) !== JSON.stringify(v.bits);

  const save = async () => {
    setSaving(true);
    try {
      await updateDataloggerVariable(v.sourceId, v.variableKey, {
        displayName: displayName.trim() || null,
        type,
        unit,
        scale: Number(scale.replace(",", ".")),
        visible: type === "analog" ? visible : false,
        ...(type === "status" ? { bits: bits.map((b) => ({ ...b, name: b.name.trim() })) } : {}),
      });
      if (color !== (defaults[seriesId]?.color ?? "")) {
        await saveDefault(seriesId, { ...(defaults[seriesId] ?? {}), color: color || undefined });
      }
      await reloadDataloggerVariables();
      toast.success(`${v.variableKey} saved`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setBit = (i: number, patch: Partial<StatusBitDef>) => setBits(bits.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const nextFreeBit = () => { for (let i = 0; i < 32; i++) if (!bits.some((b) => b.bit === i)) return i; return 0; };

  return (
    <>
      <tr className={`border-b border-border ${type === "unused" ? "opacity-60" : ""}`} data-key={v.variableKey}>
        <td className="p-2 font-mono">{v.variableKey}</td>
        <td className="p-2 text-muted-foreground">{v.name}</td>
        <td className="p-2"><input aria-label={`Display name ${v.variableKey}`} className={inp + " w-44"} placeholder={v.name} value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></td>
        <td className="p-2">
          <select aria-label={`Type ${v.variableKey}`} className={inp} value={type} onChange={(e) => setType(e.target.value as DataloggerVariableType)}>
            <option value="analog">analog</option>
            <option value="status">status word</option>
            <option value="unused">unused</option>
          </select>
        </td>
        <td className="p-2"><input aria-label={`Unit ${v.variableKey}`} className={inp + " w-16"} value={unit} onChange={(e) => setUnit(e.target.value)} disabled={type !== "analog"} /></td>
        <td className="p-2"><input aria-label={`Scale ${v.variableKey}`} className={inp + " w-20"} value={scale} onChange={(e) => setScale(e.target.value)} disabled={type !== "analog"} /></td>
        <td className="p-2"><input aria-label={`Visible ${v.variableKey}`} type="checkbox" checked={type === "analog" && visible} disabled={type !== "analog"} onChange={(e) => setVisible(e.target.checked)} /></td>
        <td className="p-2">
          <div className="flex items-center gap-1">
            <input aria-label={`Color ${v.variableKey}`} type="color" className="h-7 w-7 rounded border border-input bg-transparent p-0" value={color || SERIES_COLORS[v.position % SERIES_COLORS.length]} onChange={(e) => setColor(e.target.value)} disabled={type !== "analog"} />
            {color && <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setColor("")} title="Use automatic color">auto</button>}
          </div>
        </td>
        <td className="p-2 whitespace-nowrap text-right">
          {type === "status" && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>bits ({bits.length})</Button>
          )}
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>{saving ? "…" : "Save"}</Button>
        </td>
      </tr>
      {type === "status" && open && (
        <tr className="border-b border-border bg-secondary/20" data-bits-for={v.variableKey}>
          <td colSpan={9} className="p-3">
            <div className="space-y-1.5">
              <div className="grid grid-cols-[60px_1fr_70px_70px_70px_70px_32px] gap-2 text-[10px] uppercase font-mono text-muted-foreground">
                <span>Bit</span><span>Name</span><span>On</span><span>Off</span><span>Invert</span><span>Alarm</span><span />
              </div>
              {bits.map((b, i) => (
                <div key={i} className="grid grid-cols-[60px_1fr_70px_70px_70px_70px_32px] gap-2 items-center">
                  <input aria-label="Bit number" type="number" min={0} max={31} className={inp} value={b.bit} onChange={(e) => setBit(i, { bit: Math.max(0, Math.min(31, Number(e.target.value) || 0)) })} />
                  <input aria-label={`Bit ${b.bit} name`} className={inp} value={b.name} onChange={(e) => setBit(i, { name: e.target.value })} />
                  <input aria-label={`Bit ${b.bit} on color`} type="color" className="h-7 w-10" value={b.onColor ?? BIT_ON_DEFAULT} onChange={(e) => setBit(i, { onColor: e.target.value })} />
                  <input aria-label={`Bit ${b.bit} off color`} type="color" className="h-7 w-10" value={b.offColor ?? BIT_OFF_DEFAULT} onChange={(e) => setBit(i, { offColor: e.target.value })} />
                  <input aria-label={`Bit ${b.bit} invert`} type="checkbox" checked={!!b.invert} onChange={(e) => setBit(i, { invert: e.target.checked || undefined })} />
                  <input aria-label={`Bit ${b.bit} alarm`} type="checkbox" checked={!!b.alarm} onChange={(e) => setBit(i, { alarm: e.target.checked || undefined })} />
                  <button aria-label={`Remove bit ${b.bit}`} className="text-muted-foreground hover:text-destructive" onClick={() => setBits(bits.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
              <Button size="sm" variant="secondary" onClick={() => setBits([...bits, { bit: nextFreeBit(), name: `Bit ${nextFreeBit()}` }])}>
                <Plus className="h-3 w-3 mr-1" /> Add bit
              </Button>
              <span className="ml-2 text-[10px] text-muted-foreground">Save the row to store bit definitions.</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
