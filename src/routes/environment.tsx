import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { environmentActions, useEnvironmentStore } from "@/store/useEnvironmentStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { relativeTime } from "@/lib/format";
import { Activity, Database, MapPin, RefreshCw, Thermometer, Wifi } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/environment")({
  head: () => ({ meta: [{ title: "Environment — Myko Valvomo" }] }),
  component: EnvironmentPage,
});

type ApiEnvironmentReading = {
  id: number;
  timestamp: string;
  location: string;
  source: string;
  mqttTopic?: string;
  payloadKey?: string;
  alias?: string;
  temperatureC?: number;
  humidityRh?: number;
  co2Ppm?: number;
  note?: string;
  archived?: boolean;
};

function EnvironmentPage() {
  const { units } = useDataStore();
  const { locationRecords, readings, sources } = useEnvironmentStore();
  const [showArchived, setShowArchived] = useState(false);
  const [apiReadings, setApiReadings] = useState<ApiEnvironmentReading[]>([]);
  const [apiStatus, setApiStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [apiError, setApiError] = useState<string>("");

  const loadApiReadings = async () => {
    setApiStatus("loading");
    setApiError("");
    try {
      const response = await fetch("/api/environment/latest", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = (await response.json()) as ApiEnvironmentReading[];
      setApiReadings(data);
      setApiStatus("ok");
    } catch (error) {
      setApiStatus("error");
      setApiError((error as Error).message);
    }
  };

  useEffect(() => {
    void loadApiReadings();
    const timer = window.setInterval(() => void loadApiReadings(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleUnits = units.filter((u) => showArchived || u.status !== "ARCHIVED");
  const visibleLocationRecords = locationRecords.filter((r) => showArchived || !r.archived);
  const visibleLocalReadings = readings.filter((r) => showArchived || !r.archived).sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const latestLocalByLocation = useMemo(() => {
    const map = new Map<string, typeof readings[number]>();
    for (const r of visibleLocalReadings) {
      const prev = map.get(r.location);
      if (!prev || r.timestamp > prev.timestamp) map.set(r.location, r);
    }
    return map;
  }, [visibleLocalReadings]);

  const latestReadings = apiReadings.length > 0 ? apiReadings : Array.from(latestLocalByLocation.values());

  const currentLocationByUnit = useMemo(() => {
    const map = new Map<string, typeof locationRecords[number]>();
    for (const r of visibleLocationRecords) {
      const prev = map.get(r.unitCode);
      if (!prev || r.movedAt > prev.movedAt) map.set(r.unitCode, r);
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
        <Button size="sm" variant="secondary" onClick={() => void loadApiReadings()}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
        <div className="ml-auto text-[10px] font-mono text-muted-foreground">
          API: {apiStatus === "ok" ? "connected" : apiStatus}{apiError ? ` · ${apiError}` : ""}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-4 items-start">
        <div className="space-y-4">
          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3"><MapPin className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-mono uppercase text-muted-foreground">Unit locations</h2></div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/50 text-muted-foreground uppercase font-mono text-[10px]"><tr><th className="text-left p-2">Unit</th><th className="text-left p-2">Current location</th><th className="text-left p-2">Moved</th><th className="text-left p-2">Note</th></tr></thead>
                <tbody>
                  {visibleUnits.map((u) => {
                    const loc = currentLocationByUnit.get(u.code);
                    return <tr key={u.code} className="border-t border-border"><td className="p-2 font-mono">{u.code}</td><td className="p-2 font-mono">{loc?.location ?? u.currentLocation ?? "—"}</td><td className="p-2 text-muted-foreground">{loc ? relativeTime(loc.movedAt) : "—"}</td><td className="p-2 text-muted-foreground">{loc?.note ?? ""}</td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3"><Database className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-mono uppercase text-muted-foreground">Latest DB readings by location</h2></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {latestReadings.map((r) => (
                <div key={`${r.location}-${r.timestamp}-${r.source}`} className="border border-border rounded p-3 bg-secondary/20">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-sm">{r.location}</div>
                    {"alias" in r && r.alias && <span className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] font-mono text-muted-foreground">{r.alias}</span>}
                  </div>
                  <div className="mt-1 text-2xl font-mono">{r.temperatureC ?? "—"} °C</div>
                  <div className="text-xs text-muted-foreground">{r.humidityRh !== undefined ? `${r.humidityRh}%RH · ` : ""}{r.source} · {relativeTime(r.timestamp)}</div>
                  {"payloadKey" in r && r.payloadKey && <div className="text-[10px] font-mono text-muted-foreground mt-1">{r.payloadKey} · {r.mqttTopic}</div>}
                </div>
              ))}
              {latestReadings.length === 0 && <div className="text-xs text-muted-foreground italic">No readings yet.</div>}
            </div>
          </Card>

          <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-2 mb-3"><Wifi className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-mono uppercase text-muted-foreground">MQTT sources</h2></div>
            <div className="space-y-2">
              {sources.filter((s) => showArchived || !s.archived).map((s) => (
                <div key={s.id} className="border border-border rounded p-2 text-xs bg-secondary/20">
                  <div className="font-mono">{s.name} → {s.location}</div>
                  <div className="text-muted-foreground font-mono">{s.mqttTopic ?? "no topic"}</div>
                  {s.channelMap && <div className="mt-1 flex flex-wrap gap-1">{s.channelMap.map((c) => <span key={`${c.payloadKey}-${c.alias}`} className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{c.payloadKey} → {c.alias} → {c.location}</span>)}</div>}
                  {s.description && <div className="text-muted-foreground mt-1">{s.description}</div>}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <MoveUnitForm units={visibleUnits.map((u) => u.code)} />
          <ManualReadingForm locations={Array.from(new Set([...visibleLocationRecords.map((r) => r.location), ...sources.map((s) => s.location), ...apiReadings.map((r) => r.location), "GROW-ROOM"]))} />
          <Card className="p-4 bg-secondary/20 border-border text-xs text-muted-foreground leading-relaxed">
            <div className="font-mono uppercase text-foreground mb-1">MQTT / DB status</div>
            Sensor data is now read from the Lubuntu backend API. The MQTT logger writes SensorBlock values into MariaDB, and this page polls latest readings once per minute.
          </Card>
        </div>
      </div>
    </div>
  );
}

function MoveUnitForm({ units }: { units: string[] }) {
  const [unitCode, setUnitCode] = useState(units[0] ?? "");
  const [location, setLocation] = useState("GROW-ROOM");
  const [note, setNote] = useState("");
  const [movedAt, setMovedAt] = useState(toLocalInput(new Date()));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!unitCode || !location) return toast.error("Unit and location are required");
    environmentActions.addLocationRecord({ unitCode, location: location.trim().toUpperCase(), movedAt: new Date(movedAt).toISOString(), note: note || undefined });
    dataActions.updateUnit(unitCode, { currentLocation: location.trim().toUpperCase() });
    dataActions.addEvent({ functionCode: "OBS", unitCode, eventTime: new Date(movedAt).toISOString(), title: `Moved to ${location.trim().toUpperCase()}`, note: note || undefined });
    toast.success("Location recorded");
    setNote("");
  };

  return <Card className="p-4 bg-card border-border"><h2 className="text-sm font-mono uppercase text-muted-foreground mb-3">Move unit</h2><form onSubmit={submit} className="space-y-3"><Field label="Unit"><select value={unitCode} onChange={(e) => setUnitCode(e.target.value)} className={selectCls}>{units.map((u) => <option key={u} value={u}>{u}</option>)}</select></Field><Field label="Location"><Input value={location} onChange={(e) => setLocation(e.target.value.toUpperCase())} className="font-mono" placeholder="SHELF-A2" /></Field><Field label="Moved at"><Input type="datetime-local" value={movedAt} onChange={(e) => setMovedAt(e.target.value)} className="font-mono text-xs" /></Field><Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></Field><Button type="submit">Save location</Button></form></Card>;
}

function ManualReadingForm({ locations }: { locations: string[] }) {
  const [location, setLocation] = useState(locations[0] ?? "GROW-ROOM");
  const [temperatureC, setTemperatureC] = useState("");
  const [humidityRh, setHumidityRh] = useState("");
  const [timestamp, setTimestamp] = useState(toLocalInput(new Date()));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    environmentActions.addReading({ location: location.trim().toUpperCase(), source: "manual", timestamp: new Date(timestamp).toISOString(), temperatureC: temperatureC ? Number(temperatureC) : undefined, humidityRh: humidityRh ? Number(humidityRh) : undefined });
    toast.success("Reading recorded locally");
    setTemperatureC(""); setHumidityRh("");
  };

  return <Card className="p-4 bg-card border-border"><h2 className="text-sm font-mono uppercase text-muted-foreground mb-3">Manual reading (local fallback)</h2><form onSubmit={submit} className="space-y-3"><Field label="Location"><Input value={location} onChange={(e) => setLocation(e.target.value.toUpperCase())} className="font-mono" /></Field><div className="grid grid-cols-2 gap-2"><Field label="Temperature °C"><Input value={temperatureC} onChange={(e) => setTemperatureC(e.target.value)} inputMode="decimal" /></Field><Field label="Humidity %RH"><Input value={humidityRh} onChange={(e) => setHumidityRh(e.target.value)} inputMode="decimal" /></Field></div><Field label="Timestamp"><Input type="datetime-local" value={timestamp} onChange={(e) => setTimestamp(e.target.value)} className="font-mono text-xs" /></Field><Button type="submit">Save local reading</Button></form></Card>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</Label>{children}</div>; }
const selectCls = "h-9 w-full bg-input text-foreground border border-border rounded px-2 text-sm font-mono";
function toLocalInput(d: Date) { const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
