import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useEnvironmentStore } from "@/store/useEnvironmentStore";
import {
  getDbState,
  getLatestEnvironmentReadings,
  getUnitLocations,
  saveEnvironmentReading,
  saveUnitLocation,
} from "@/lib/apiClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { relativeTime } from "@/lib/format";
import type { EnvironmentReading, EnvironmentSource, Unit, UnitLocationRecord } from "@/types";
import { Database, MapPin, RefreshCw, Thermometer, Wifi } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/environment")({
  head: () => ({ meta: [{ title: "Environment - Myko Valvomo" }] }),
  component: EnvironmentPage,
});

function EnvironmentPage() {
  const { sources } = useEnvironmentStore();
  const [units, setUnits] = useState<Unit[]>([]);
  const [locationRecords, setLocationRecords] = useState<UnitLocationRecord[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [readings, setReadings] = useState<EnvironmentReading[]>([]);
  const [apiStatus, setApiStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [apiError, setApiError] = useState("");

  const loadApiData = async () => {
    setApiStatus("loading");
    setApiError("");
    try {
      const [state, locations, latestReadings] = await Promise.all([
        getDbState(),
        getUnitLocations(),
        getLatestEnvironmentReadings(),
      ]);
      setUnits(state.units);
      setLocationRecords(locations);
      setReadings(latestReadings);
      setApiStatus("ok");
    } catch (error) {
      setApiStatus("error");
      setApiError((error as Error).message);
    }
  };

  useEffect(() => {
    void loadApiData();
    const timer = window.setInterval(() => void loadApiData(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleUnits = units.filter((u) => showArchived || u.status !== "ARCHIVED");
  const visibleLocationRecords = locationRecords.filter((r) => showArchived || !r.archived);
  const locationOptions = useMemo(
    () => buildLocationOptions(visibleLocationRecords, sources, readings, units),
    [visibleLocationRecords, sources, readings, units],
  );

  const currentLocationByUnit = useMemo(() => {
    const map = new Map<string, UnitLocationRecord>();
    for (const record of visibleLocationRecords) {
      const prev = map.get(record.unitCode);
      if (!prev || record.movedAt > prev.movedAt) map.set(record.unitCode, record);
    }
    return map;
  }, [visibleLocationRecords]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-mono flex items-center gap-2"><Thermometer className="h-4 w-4" /> Environment & locations</h1>
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        <Button size="sm" variant="secondary" onClick={() => void loadApiData()}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
        <div className="ml-auto text-[10px] font-mono text-muted-foreground">
          API: {apiStatus === "ok" ? "connected" : apiStatus}{apiError ? ` - ${apiError}` : ""}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-4 items-start">
        <div className="space-y-4">
          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3"><MapPin className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-mono uppercase text-muted-foreground">Unit locations</h2></div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/50 text-muted-foreground uppercase font-mono text-[10px]">
                  <tr><th className="text-left p-2">Unit</th><th className="text-left p-2">Current location</th><th className="text-left p-2">Moved</th><th className="text-left p-2">Note</th></tr>
                </thead>
                <tbody>
                  {visibleUnits.map((unit) => {
                    const loc = currentLocationByUnit.get(unit.code);
                    return (
                      <tr key={unit.code} className="border-t border-border">
                        <td className="p-2 font-mono">{unit.code}</td>
                        <td className="p-2 font-mono">{loc?.location ?? unit.currentLocation ?? "-"}</td>
                        <td className="p-2 text-muted-foreground">{loc ? relativeTime(loc.movedAt) : "-"}</td>
                        <td className="p-2 text-muted-foreground">{loc?.note ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3"><Database className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-mono uppercase text-muted-foreground">Latest DB readings by location</h2></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {readings.map((reading) => (
                <div key={`${reading.location}-${reading.timestamp}-${reading.source}`} className="border border-border rounded p-3 bg-secondary/20">
                  <div className="font-mono text-sm">{reading.location}</div>
                  <div className="mt-1 text-2xl font-mono">{reading.temperatureC ?? "-"} C</div>
                  <div className="text-xs text-muted-foreground">{reading.humidityRh !== undefined ? `${reading.humidityRh}%RH - ` : ""}{reading.source} - {relativeTime(reading.timestamp)}</div>
                </div>
              ))}
              {readings.length === 0 && <div className="text-xs text-muted-foreground italic">No readings yet.</div>}
            </div>
          </Card>

          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3"><Wifi className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-mono uppercase text-muted-foreground">MQTT sources</h2></div>
            <div className="space-y-2">
              {sources.filter((source) => showArchived || !source.archived).map((source) => (
                <div key={source.id} className="border border-border rounded p-2 text-xs bg-secondary/20">
                  <div className="font-mono">{source.name} - {source.location}</div>
                  <div className="text-muted-foreground font-mono">{source.mqttTopic ?? "no topic"}</div>
                  {source.channelMap && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {source.channelMap.map((channel) => (
                        <span key={`${channel.payloadKey}-${channel.alias}`} className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {channel.payloadKey} - {channel.alias} - {channel.location}
                        </span>
                      ))}
                    </div>
                  )}
                  {source.description && <div className="text-muted-foreground mt-1">{source.description}</div>}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <MoveUnitForm
            units={visibleUnits.map((unit) => unit.code)}
            locations={locationOptions}
            onSaved={loadApiData}
          />
          <ManualReadingForm locations={locationOptions} onSaved={loadApiData} />
          <Card className="p-4 bg-secondary/20 border-border text-xs text-muted-foreground leading-relaxed">
            <div className="font-mono uppercase text-foreground mb-1">MQTT / DB status</div>
            Sensor data is read from the Lubuntu backend API. The MQTT logger writes SensorBlock values into MariaDB, and this page polls latest readings once per minute.
          </Card>
        </div>
      </div>
    </div>
  );
}

function MoveUnitForm({ units, locations, onSaved }: { units: string[]; locations: string[]; onSaved: () => void | Promise<void> }) {
  const [unitCode, setUnitCode] = useState(units[0] ?? "");
  const [locationMode, setLocationMode] = useState<"preset" | "custom">("preset");
  const [location, setLocation] = useState(locations[0] ?? "");
  const [customLocation, setCustomLocation] = useState("");
  const [note, setNote] = useState("");
  const [movedAt, setMovedAt] = useState(toLocalInput(new Date()));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!unitCode && units[0]) setUnitCode(units[0]);
  }, [unitCode, units]);

  useEffect(() => {
    if (!location && locations[0]) setLocation(locations[0]);
  }, [location, locations]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const finalLocation = normalizeLocation(locationMode === "custom" ? customLocation : location);
    if (!unitCode || !finalLocation) return toast.error("Unit and location are required");

    setSaving(true);
    try {
      await saveUnitLocation({
        unitCode,
        location: finalLocation,
        movedAt: new Date(movedAt).toISOString(),
        note: note || undefined,
      });
      toast.success("Location recorded in MariaDB");
      setLocationMode("preset");
      setLocation(finalLocation);
      setCustomLocation("");
      setNote("");
      await onSaved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 bg-card border-border">
      <h2 className="text-sm font-mono uppercase text-muted-foreground mb-3">Move unit</h2>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Unit">
          <select value={unitCode} onChange={(event) => setUnitCode(event.target.value)} className={selectCls}>
            {units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
          </select>
        </Field>
        <Field label="Location">
          <select
            value={locationMode === "custom" ? "__CUSTOM__" : location}
            onChange={(event) => {
              if (event.target.value === "__CUSTOM__") {
                setLocationMode("custom");
              } else {
                setLocationMode("preset");
                setLocation(event.target.value);
              }
            }}
            className={selectCls}
          >
            {locations.map((loc) => <option key={loc} value={loc}>{loc}</option>)}
            <option value="__CUSTOM__">Add custom location...</option>
          </select>
        </Field>
        {locationMode === "custom" && (
          <Field label="Custom location">
            <Input value={customLocation} onChange={(event) => setCustomLocation(event.target.value.toUpperCase())} className="font-mono" placeholder="SHELF-A2" />
          </Field>
        )}
        <Field label="Moved at"><Input type="datetime-local" value={movedAt} onChange={(event) => setMovedAt(event.target.value)} className="font-mono text-xs" /></Field>
        <Field label="Note"><Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} /></Field>
        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save location"}</Button>
      </form>
    </Card>
  );
}

function ManualReadingForm({ locations, onSaved }: { locations: string[]; onSaved: () => void | Promise<void> }) {
  const [location, setLocation] = useState(locations[0] ?? "");
  const [temperatureC, setTemperatureC] = useState("");
  const [humidityRh, setHumidityRh] = useState("");
  const [timestamp, setTimestamp] = useState(toLocalInput(new Date()));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!location && locations[0]) setLocation(locations[0]);
  }, [location, locations]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const finalLocation = normalizeLocation(location);
    if (!finalLocation) return toast.error("Location is required");
    if (!temperatureC && !humidityRh) return toast.error("At least one metric is required");

    setSaving(true);
    try {
      await saveEnvironmentReading({
        location: finalLocation,
        source: "manual",
        timestamp: new Date(timestamp).toISOString(),
        temperatureC: temperatureC ? Number(temperatureC) : undefined,
        humidityRh: humidityRh ? Number(humidityRh) : undefined,
      });
      toast.success("Reading saved to MariaDB");
      setTemperatureC("");
      setHumidityRh("");
      await onSaved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 bg-card border-border">
      <h2 className="text-sm font-mono uppercase text-muted-foreground mb-3">Manual reading</h2>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Location">
          <select value={location} onChange={(event) => setLocation(event.target.value)} className={selectCls}>
            {locations.map((loc) => <option key={loc} value={loc}>{loc}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Temperature C"><Input value={temperatureC} onChange={(event) => setTemperatureC(event.target.value)} inputMode="decimal" /></Field>
          <Field label="Humidity %RH"><Input value={humidityRh} onChange={(event) => setHumidityRh(event.target.value)} inputMode="decimal" /></Field>
        </div>
        <Field label="Timestamp"><Input type="datetime-local" value={timestamp} onChange={(event) => setTimestamp(event.target.value)} className="font-mono text-xs" /></Field>
        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save reading"}</Button>
      </form>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</Label>{children}</div>;
}

const selectCls = "h-9 w-full bg-input text-foreground border border-border rounded px-2 text-sm font-mono";

function toLocalInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeLocation(value: string) {
  return value.trim().toUpperCase();
}

function buildLocationOptions(
  locationRecords: UnitLocationRecord[],
  sources: EnvironmentSource[],
  readings: EnvironmentReading[],
  units: Unit[],
) {
  const values = [
    ...locationRecords.map((record) => record.location),
    ...sources.map((source) => source.location),
    ...sources.flatMap((source) => source.channelMap?.map((channel) => channel.location) ?? []),
    ...readings.map((reading) => reading.location),
    ...units.map((unit) => unit.currentLocation).filter(Boolean),
  ];
  const unique = Array.from(new Set(values.map((value) => normalizeLocation(String(value))).filter(Boolean))).sort();
  return unique.length > 0 ? unique : ["GROW-ROOM"];
}
