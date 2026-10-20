import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { getUnits } from "@/lib/apiClient";
import { ORIGIN_TYPES, exportUrl, getUnitTrace, setUnitOrigins, type OriginInput, type TraceNode, type UnitTrace } from "@/lib/traceApi";
import { OriginEditor, cleanOrigins } from "./OriginEditor";

const originLabel = (t: string) => ORIGIN_TYPES.find((o) => o.value === t)?.label ?? t;

/** Origin, ancestry/descendants, full timeline (events, transfers, moves, audit) and export for one unit. */
export function UnitTracePanel({ unitCode, onChanged }: { unitCode: string; onChanged?: () => void }) {
  const [trace, setTrace] = useState<UnitTrace | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<OriginInput[]>([]);
  const [codes, setCodes] = useState<string[]>([]);
  const [showAudit, setShowAudit] = useState(false);

  const load = async () => {
    try { const t = await getUnitTrace(unitCode); setTrace(t); setError(""); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [unitCode]);

  const startEdit = async () => {
    setDraft((trace?.unit.origins ?? []).map((o) => ({ type: o.type, parentUnitCode: o.parentUnitCode, note: o.note })));
    setEditing(true);
    try { setCodes((await getUnits()).map((u) => u.code)); } catch { /* datalist optional */ }
  };
  const save = async () => {
    try { await setUnitOrigins(unitCode, cleanOrigins(draft)); toast.success("Origin saved"); setEditing(false); await load(); onChanged?.(); }
    catch (e) { toast.error((e as Error).message); }
  };

  if (error) return <Card className="p-3 text-xs text-destructive">Traceability: {error}</Card>;
  if (!trace) return <Card className="p-3 text-xs text-muted-foreground">Loading traceability…</Card>;
  const u = trace.unit;
  const timeline = trace.timeline.filter((t) => showAudit || t.kind !== "audit");

  return (
    <Card className="p-4 bg-card border-border space-y-4" data-testid="trace-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-medium">Traceability</div>
        <div className="ml-auto flex gap-2">
          <a className="text-xs underline text-primary" href={exportUrl(unitCode, "csv")} data-testid="export-csv">Export CSV</a>
          <a className="text-xs underline text-primary" href={exportUrl(unitCode, "json")} data-testid="export-json">Export JSON</a>
        </div>
      </div>

      <section className="space-y-1">
        <div className="text-[10px] uppercase font-mono text-muted-foreground">Origin</div>
        {!editing ? (
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="origin-list">
            {u.origins.length === 0 && <span className="text-amber-500">Origin not recorded</span>}
            {u.origins.map((o) => (
              <span key={o.id} className="rounded border border-border px-2 py-0.5 font-mono">
                {o.type === "UNIT" && o.parentUnitCode ? (
                  <>Parent <Link to="/units/$unitCode" params={{ unitCode: o.parentUnitCode }} className="text-primary hover:underline">{o.parentUnitCode}</Link></>
                ) : originLabel(o.type)}
                {o.note ? <span className="text-muted-foreground"> — {o.note}</span> : null}
              </span>
            ))}
            <Button size="sm" variant="ghost" onClick={startEdit}>Edit origin</Button>
          </div>
        ) : (
          <div className="space-y-2">
            <OriginEditor value={draft} onChange={setDraft} unitCodes={codes} exclude={[unitCode]} />
            <div className="flex gap-2"><Button size="sm" onClick={save}>Save origin</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
          </div>
        )}
        <div className="text-xs">
          Strain: <span className="font-mono">{u.effectiveStrainCode ? `#${u.effectiveStrainCode}` : "—"}</span>
          {u.strainInheritedFrom ? <span className="text-muted-foreground"> (inherited from {u.strainInheritedFrom})</span> : null}
        </div>
      </section>

      <div className="grid md:grid-cols-2 gap-4">
        <NodeList title={`Ancestors (${trace.ancestors.length})`} nodes={trace.ancestors} testId="ancestors" />
        <NodeList title={`Descendants (${trace.descendants.length})`} nodes={trace.descendants} testId="descendants" />
      </div>

      <section className="space-y-1">
        <div className="text-[10px] uppercase font-mono text-muted-foreground">Environment by location</div>
        {trace.environment.periods.length === 0 ? (
          <div className="text-xs text-muted-foreground">{trace.environment.unlocatedNote ?? "No readings"}</div>
        ) : (
          <table className="w-full text-xs"><thead className="text-[10px] uppercase text-muted-foreground"><tr>
            <th className="text-left">Location</th><th className="text-left">From</th><th className="text-left">To</th><th className="text-right">Readings</th><th className="text-right">T min/avg/max °C</th><th className="text-right">RH avg %</th></tr></thead>
            <tbody>{trace.environment.periods.map((p, i) => (
              <tr key={i} className="border-t border-border"><td className="font-mono">{p.location}</td><td>{formatDateTime(p.from)}</td><td>{formatDateTime(p.to)}</td>
                <td className="text-right">{p.readings}</td>
                <td className="text-right font-mono">{p.temperatureAvg === null ? "no sensor data" : `${p.temperatureMin} / ${p.temperatureAvg} / ${p.temperatureMax}`}</td>
                <td className="text-right font-mono">{p.humidityAvg ?? "—"}</td></tr>))}</tbody></table>
        )}
      </section>

      <section className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="text-[10px] uppercase font-mono text-muted-foreground">Timeline ({timeline.length})</div>
          <label className="ml-auto text-[10px] font-mono text-muted-foreground flex items-center gap-1">
            <input type="checkbox" checked={showAudit} onChange={(e) => setShowAudit(e.target.checked)} /> include audit log
          </label>
        </div>
        <ol className="space-y-1 text-xs" data-testid="timeline">
          {[...timeline].reverse().map((t) => (
            <li key={`${t.kind}-${t.id}`} className="border-l-2 border-border pl-2">
              <span className="text-muted-foreground font-mono">{formatDateTime(t.at)}</span>{" "}
              <span className="rounded bg-muted px-1 font-mono text-[10px] uppercase">{t.functionCode ?? t.kind}</span>{" "}
              {t.title}
              {t.statusChange ? <span className="text-amber-500"> → {t.statusChange}</span> : null}
              {t.detail ? <span className="text-muted-foreground"> — {t.detail}</span> : null}
              {t.actor ? <span className="text-muted-foreground"> [{t.actor}]</span> : null}
              {t.operationId ? <span className="text-muted-foreground font-mono text-[10px]"> {t.operationId}</span> : null}
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}

function NodeList({ title, nodes, testId }: { title: string; nodes: TraceNode[]; testId: string }) {
  return (
    <section className="space-y-1" data-testid={testId}>
      <div className="text-[10px] uppercase font-mono text-muted-foreground">{title}</div>
      {nodes.length === 0 ? <div className="text-xs text-muted-foreground">none</div> : (
        <ul className="text-xs space-y-0.5">
          {nodes.map((n) => (
            <li key={n.code} style={{ paddingLeft: `${(n.depth - 1) * 12}px` }}>
              <Link to="/units/$unitCode" params={{ unitCode: n.code }} className="font-mono text-primary hover:underline">{n.code}</Link>
              <span className="text-muted-foreground"> {n.type} · {n.status}{n.effectiveStrainCode ? ` · #${n.effectiveStrainCode}` : ""}{n.hidden ? " · hidden" : ""}</span>
              {n.origins.filter((o) => o.type !== "UNIT").map((o) => <span key={o.id} className="text-muted-foreground"> · {originLabel(o.type)}</span>)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
