import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MapPin, MoveRight, Thermometer, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  archiveUnitLocation,
  getUnitEnvironment,
  getUnitLocations,
  moveUnit,
  type UnitEnvironment,
} from "@/lib/apiClient";
import { formatDateTime, relativeTime } from "@/lib/format";
import type { Unit, UnitLocationRecord } from "@/types";

import { KNOWN_LOCATIONS } from "@/lib/locations";
const selectCls =
  "w-full h-9 rounded-md border border-input bg-background px-2 text-sm font-mono";

function toLocalInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function UnitLocationPanel({
  unit,
  onMoved,
}: {
  unit: Unit;
  onMoved?: () => void | Promise<void>;
}) {
  const [allLocations, setAllLocations] = useState<string[]>(KNOWN_LOCATIONS);
  const [env, setEnv] = useState<UnitEnvironment | null>(null);
  const [envError, setEnvError] = useState("");
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState("");
  const [custom, setCustom] = useState("");
  const [movedAt, setMovedAt] = useState(toLocalInput(new Date()));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const isArchived = unit.status === "ARCHIVED";

  const load = useCallback(async () => {
    try {
      const [records, environment] = await Promise.all([
        getUnitLocations(),
        getUnitEnvironment(unit.code),
      ]);
      const locs = new Set<string>(KNOWN_LOCATIONS);
      records.forEach((r: UnitLocationRecord) => locs.add(r.location));
      setAllLocations(Array.from(locs).sort());
      setEnv(environment);
      setEnvError("");
    } catch (error) {
      setEnvError((error as Error).message);
    }
  }, [unit.code]);

  useEffect(() => {
    void load();
  }, [load]);

  const moves = useMemo(
    () => [...(env?.moves ?? [])].sort((a, b) => (a.movedAt < b.movedAt ? 1 : -1)),
    [env],
  );
  const current = moves[0]?.location ?? unit.currentLocation ?? null;

  const openMove = () => {
    const firstOther = allLocations.find((l) => l !== current) ?? allLocations[0] ?? "";
    setTarget(firstOther);
    setCustom("");
    setNote("");
    setMovedAt(toLocalInput(new Date()));
    setMoving(true);
  };

  const confirmMove = async () => {
    const location = (target === "__CUSTOM__" ? custom : target).trim().toUpperCase();
    if (!location) return toast.error("Pick a target location");
    if (location === current) return toast.error(`${unit.code} is already in ${location}`);
    if (!confirm(`Move ${unit.code} from ${current ?? "unknown"} to ${location}?`)) return;
    setSaving(true);
    try {
      await moveUnit({
        unitCode: unit.code,
        location,
        movedAt: new Date(movedAt).toISOString(),
        note: note.trim() || undefined,
      });
      toast.success(`${unit.code} moved to ${location}`);
      setMoving(false);
      await load();
      await onMoved?.();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const undoMove = async (record: UnitLocationRecord) => {
    if (!confirm(`Remove the move to ${record.location} (${formatDateTime(record.movedAt)}) from history?`)) return;
    try {
      await archiveUnitLocation(record.id);
      toast.success("Move removed from history");
      await load();
      await onMoved?.();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const chartData = useMemo(
    () =>
      (env?.points ?? []).map((p) => ({
        ...p,
        ts: new Date(p.timestamp).getTime(),
      })),
    [env],
  );
  const hasHumidity = chartData.some((p) => p.humidityRh !== null);
  const fmtTick = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "numeric" });

  return (
    <>
      <Card className="p-4 bg-card border-border">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
            Location
          </h2>
          {!isArchived && !moving && (
            <Button size="sm" className="ml-auto" onClick={openMove}>
              <MoveRight className="h-3 w-3 mr-1" /> Move
            </Button>
          )}
        </div>
        <div className="text-lg font-mono">{current ?? "— unknown —"}</div>
        {moves[0] && (
          <div className="text-[10px] text-muted-foreground">
            since {formatDateTime(moves[0].movedAt)} ({relativeTime(moves[0].movedAt)})
          </div>
        )}

        {moving && (
          <div className="mt-3 space-y-2 border border-border rounded p-3 bg-secondary/20">
            <label className="block text-[10px] font-mono uppercase text-muted-foreground">
              Target location
              <select value={target} onChange={(e) => setTarget(e.target.value)} className={selectCls}>
                {allLocations.map((l) => (
                  <option key={l} value={l} disabled={l === current}>
                    {l}
                    {l === current ? " (current)" : ""}
                  </option>
                ))}
                <option value="__CUSTOM__">Other…</option>
              </select>
            </label>
            {target === "__CUSTOM__" && (
              <Input
                value={custom}
                onChange={(e) => setCustom(e.target.value.toUpperCase())}
                placeholder="SHELF-A2"
                className="font-mono"
              />
            )}
            <label className="block text-[10px] font-mono uppercase text-muted-foreground">
              Moved at
              <Input type="datetime-local" value={movedAt} onChange={(e) => setMovedAt(e.target.value)} className="font-mono text-xs" />
            </label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void confirmMove()} disabled={saving}>
                {saving ? "Saving…" : "Confirm move"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMoving(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3 space-y-1">
          <div className="text-[10px] font-mono uppercase text-muted-foreground">History</div>
          {moves.map((m, i) => (
            <div key={m.id} className="flex items-center gap-2 text-xs border-t border-border pt-1">
              <span className="font-mono">{m.location}</span>
              <span className="text-muted-foreground">{formatDateTime(m.movedAt)}</span>
              {m.note && <span className="text-muted-foreground italic truncate">{m.note}</span>}
              {i === 0 && !isArchived && (
                <button
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  title="Undo this move"
                  onClick={() => void undoMove(m)}
                >
                  <Undo2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          {moves.length === 0 && (
            <div className="text-xs text-muted-foreground italic">No moves recorded.</div>
          )}
        </div>
      </Card>

      <Card className="p-4 bg-card border-border">
        <div className="flex items-center gap-2 mb-3">
          <Thermometer className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
            Lifetime environment
          </h2>
          {env && (
            <span className="ml-auto text-[10px] font-mono text-muted-foreground">
              {formatDateTime(env.from)} → {env.ended ? formatDateTime(env.to) : "now"} ·{" "}
              {Math.round(env.bucketSeconds / 60)} min avg
            </span>
          )}
        </div>
        {envError && <div className="text-xs text-destructive">{envError}</div>}
        {env && env.periods.length === 0 && (
          <div className="text-xs text-muted-foreground italic">
            No location history for this unit, so no sensor data can be attached. Use Move to record where it is.
          </div>
        )}
        {env && env.periods.length > 0 && chartData.length === 0 && (
          <div className="text-xs text-muted-foreground italic">
            No sensor readings for the locations/periods of this unit.
          </div>
        )}
        {chartData.length > 0 && (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={fmtTick} tick={{ fontSize: 10 }} />
                <YAxis yAxisId="t" tick={{ fontSize: 10 }} unit="°" />
                {hasHumidity && <YAxis yAxisId="rh" orientation="right" domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" />}
                <Tooltip
                  labelFormatter={(ts) => formatDateTime(new Date(Number(ts)).toISOString())}
                  formatter={(value: number, name: string) => [value, name]}
                  contentStyle={{ fontSize: 11 }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line yAxisId="t" dataKey="temperatureC" name="Temp °C" stroke="#f97316" dot={false} strokeWidth={1.5} connectNulls={false} isAnimationActive={false} />
                {hasHumidity && (
                  <Line yAxisId="rh" dataKey="humidityRh" name="RH %" stroke="#38bdf8" dot={false} strokeWidth={1} isAnimationActive={false} />
                )}
                {(env?.moves ?? []).map((m) => (
                  <ReferenceLine
                    key={m.id}
                    yAxisId="t"
                    x={new Date(m.movedAt).getTime()}
                    stroke="#a3a3a3"
                    strokeDasharray="4 2"
                    label={{ value: `→ ${m.location}`, position: "insideTopLeft", fontSize: 9, fill: "#a3a3a3" }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {env && env.periods.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {env.periods.map((p) => (
              <span key={p.from} className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                {p.location}: {formatDateTime(p.from)} → {formatDateTime(p.to)}
                {p.assumed ? " (assumed)" : ""}
              </span>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
