import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDashboardData } from "./DashboardData";
import { autoBucket, BUCKET_OPTIONS } from "@/lib/seriesStyle";
import { SeriesStyleEditor } from "@/components/trends/SeriesStyleEditor";
import { dlLabel, useDataloggerVariables } from "@/lib/statusBits";
import { usePointList } from "./MeasurementPointWidget";
import { STATUSES, WIDGET_META, type DashboardWidget, type WidgetConfigMap } from "./types";

const selectCls = "w-full h-9 rounded-md border border-input bg-background px-2 text-sm font-mono";
const FUNCTION_CODES = ["COL", "FRU", "HAR", "INOC", "OBS", "PREP", "QC", "TRF"];
const RANGES = [
  { h: 6, label: "6 h" },
  { h: 24, label: "24 h" },
  { h: 72, label: "3 d" },
  { h: 168, label: "7 d" },
  { h: 720, label: "30 d" },
  { h: 2160, label: "90 d" },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-mono uppercase text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function WidgetSettingsDialog({
  widget,
  onClose,
  onSave,
}: {
  widget: DashboardWidget | null;
  onClose: () => void;
  onSave: (w: DashboardWidget) => void;
}) {
  const { variables, units } = useDashboardData();
  const dlVars = useDataloggerVariables();
  const alarmPoints = usePointList();
  const [draft, setDraft] = useState<DashboardWidget | null>(widget);
  useEffect(() => setDraft(widget), [widget]);
  if (!draft) return null;

  const cfg = draft.config as Record<string, unknown>;
  const setCfg = (patch: Record<string, unknown>) =>
    setDraft({ ...draft, config: { ...cfg, ...patch } as DashboardWidget["config"] });

  const variableSelect = (value: string | undefined, onChange: (v: string) => void) => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={selectCls}>
      <option value="">— select —</option>
      {variables.map((v) => (
        <option key={v.id} value={v.id}>
          {v.label}
          {v.unit ? ` (${v.unit})` : ""}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase">{WIDGET_META[draft.type].label} settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Title (optional)">
            <Input value={draft.title ?? ""} onChange={(e) => setDraft({ ...draft, title: e.target.value || undefined })} />
          </Field>

          {draft.type === "sensorLatest" &&
            <Field label="Sensor / variable">
              {variableSelect((cfg as WidgetConfigMap["sensorLatest"]).variableId, (v) => setCfg({ variableId: v || undefined }))}
            </Field>}

          {draft.type === "trend" && (() => {
            const c = cfg as WidgetConfigMap["trend"];
            const ids = c.variableIds ?? [];
            return (
              <>
                <Field label="Time range">
                  <select value={c.rangeHours ?? 24} onChange={(e) => setCfg({ rangeHours: Number(e.target.value) })} className={selectCls}>
                    {RANGES.map((r) => <option key={r.h} value={r.h}>{r.label}</option>)}
                  </select>
                </Field>
                <Field label="Resolution">
                  <select value={c.bucket ?? "auto"} onChange={(e) => setCfg({ bucket: e.target.value === "auto" ? undefined : e.target.value })} className={selectCls}>
                    <option value="auto">Auto ({BUCKET_OPTIONS.find((b) => b.value === autoBucket(c.rangeHours ?? 24))?.label})</option>
                    {BUCKET_OPTIONS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </select>
                </Field>
                <Field label={`Variables (${ids.length} selected)`}>
                  <div className="max-h-56 overflow-y-auto rounded border border-border p-2 space-y-1">
                    {variables.map((v) => (
                      <label key={v.id} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={ids.includes(v.id)}
                          onChange={(e) =>
                            setCfg({ variableIds: e.target.checked ? [...ids, v.id] : ids.filter((x) => x !== v.id) })
                          }
                        />
                        <span className="font-mono truncate">{v.label}</span>
                      </label>
                    ))}
                    {variables.length === 0 && <span className="text-xs text-muted-foreground">Loading variables…</span>}
                  </div>
                </Field>
                <SeriesStyleEditor
                  ids={ids}
                  variables={variables}
                  styling={c}
                  onChange={(st) => setCfg({ series: st.series, axes: st.axes })}
                />
              </>
            );
          })()}

          {draft.type === "unitsByStatus" && (() => {
            const c = cfg as WidgetConfigMap["unitsByStatus"];
            return (
              <>
                <Field label="Mode">
                  <select value={c.mode ?? "count"} onChange={(e) => setCfg({ mode: e.target.value })} className={selectCls}>
                    <option value="count">Counts per status</option>
                    <option value="list">List units with one status</option>
                  </select>
                </Field>
                {c.mode === "list" && (
                  <Field label="Status">
                    <select value={c.status ?? "ACTIVE"} onChange={(e) => setCfg({ status: e.target.value })} className={selectCls}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                )}
              </>
            );
          })()}

          {draft.type === "recentEvents" && (() => {
            const c = cfg as WidgetConfigMap["recentEvents"];
            return (
              <>
                <Field label="Number of events">
                  <Input type="number" min={1} max={50} value={c.limit ?? 8} onChange={(e) => setCfg({ limit: Math.min(50, Math.max(1, Number(e.target.value) || 8)) })} />
                </Field>
                <Field label="Function">
                  <select value={c.functionCode ?? ""} onChange={(e) => setCfg({ functionCode: e.target.value || undefined })} className={selectCls}>
                    <option value="">All</option>
                    {FUNCTION_CODES.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </Field>
              </>
            );
          })()}

          {draft.type === "unitCurve" && (
            <Field label="Unit">
              <select
                value={(cfg as WidgetConfigMap["unitCurve"]).unitCode ?? ""}
                onChange={(e) => setCfg({ unitCode: e.target.value || undefined })}
                className={selectCls}
              >
                <option value="">— select —</option>
                {[...units]
                  .sort((a, b) => Number(Boolean(b.currentLocation)) - Number(Boolean(a.currentLocation)) || a.code.localeCompare(b.code))
                  .map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.code} · {u.status}{u.currentLocation ? ` · ${u.currentLocation}` : ""}
                    </option>
                  ))}
              </select>
            </Field>
          )}

          {draft.type === "statusBits" && (() => {
            const c = cfg as WidgetConfigMap["statusBits"];
            const words = dlVars.filter((v) => v.type === "status");
            const word = words.find((v) => v.variableKey === c.variableKey);
            const shown = c.bits ?? [];
            return (
              <>
                <Field label="Status word">
                  <select value={c.variableKey ?? ""} onChange={(e) => setCfg({ variableKey: e.target.value || undefined, bits: undefined })} className={selectCls}>
                    <option value="">— select —</option>
                    {words.map((v) => (
                      <option key={v.variableKey} value={v.variableKey}>{v.variableKey} · {dlLabel(v)}</option>
                    ))}
                  </select>
                </Field>
                {word && (
                  <Field label={`Bits to show (${shown.length ? shown.length : "all"})`}>
                    <div className="max-h-48 overflow-y-auto rounded border border-border p-2 space-y-1">
                      {word.bits.map((b) => (
                        <label key={b.bit} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={!shown.length || shown.includes(b.bit)}
                            onChange={(e) => {
                              const base = shown.length ? shown : word.bits.map((x) => x.bit);
                              const next = e.target.checked ? [...base, b.bit] : base.filter((x) => x !== b.bit);
                              setCfg({ bits: next.length === word.bits.length ? undefined : next.sort((x, y) => x - y) });
                            }}
                          />
                          <span className="font-mono">bit {b.bit}</span> {b.name}
                        </label>
                      ))}
                      {word.bits.length === 0 && <span className="text-xs text-muted-foreground">No bits defined — use Settings → Datalogger variables.</span>}
                    </div>
                  </Field>
                )}
                <Field label="Stale after (minutes)">
                  <Input type="number" min={1} max={1440} value={c.staleMinutes ?? 10} onChange={(e) => setCfg({ staleMinutes: Math.max(1, Number(e.target.value) || 10) })} />
                </Field>
              </>
            );
          })()}

          {draft.type === "measurementPoint" && (() => {
            const c = cfg as WidgetConfigMap["measurementPoint"];
            return (
              <>
                <Field label="Measurement point">
                  <select value={c.pointId ?? ""} onChange={(e) => setCfg({ pointId: e.target.value || undefined })} className={selectCls}>
                    <option value="">— select —</option>
                    {alarmPoints.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} · {p.topicPrefix}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Display name (optional)">
                  <Input value={c.name ?? ""} onChange={(e) => setCfg({ name: e.target.value || undefined })} />
                </Field>
              </>
            );
          })()}

          {draft.type === "note" && (
            <Field label="Text">
              <Textarea rows={6} value={(cfg as WidgetConfigMap["note"]).text ?? ""} onChange={(e) => setCfg({ text: e.target.value })} />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(draft)}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
