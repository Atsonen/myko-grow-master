import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Thermometer, ExternalLink } from "lucide-react";
import { relativeTime } from "@/lib/format";
import type { ApiEnvironmentReading } from "@/types/environment";

type Status = "idle" | "loading" | "ok" | "error";

export function LatestTemperaturesCard() {
  const [readings, setReadings] = useState<ApiEnvironmentReading[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setStatus((s) => (s === "ok" ? s : "loading"));
      try {
        const response = await fetch("/api/environment/latest", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = (await response.json()) as ApiEnvironmentReading[];
        if (cancelled) return;
        setReadings(data);
        setStatus("ok");
        setError("");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError((err as Error).message);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const tempReadings = readings.filter((r) => r.temperatureC !== undefined && r.temperatureC !== null);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="py-3 flex-row items-center justify-between">
        <CardTitle className="text-sm font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Thermometer className="h-4 w-4" /> Latest temperatures
        </CardTitle>
        <Link to="/environment" className="text-[10px] font-mono text-muted-foreground hover:text-foreground flex items-center gap-1">
          environment <ExternalLink className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-2">
        {tempReadings.length === 0 && (
          <div className="text-xs text-muted-foreground italic px-1 py-2">
            {status === "error" ? `API: ${error}` : status === "loading" ? "Loading…" : "No DB readings yet"}
          </div>
        )}
        {tempReadings.map((r) => (
          <div key={`${r.location}-${r.timestamp}-${r.source}`} className="border border-border rounded p-2 bg-secondary/20">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs">{r.location}</span>
              {r.alias && (
                <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">{r.alias}</span>
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-mono">{r.temperatureC?.toFixed(1)} °C</span>
              {r.humidityRh !== undefined && r.humidityRh !== null && (
                <span className="text-[10px] font-mono text-muted-foreground">{r.humidityRh}%RH</span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground">{relativeTime(r.timestamp)}</div>
          </div>
        ))}
        <div className="text-[10px] font-mono text-muted-foreground pt-1">
          API: {status === "ok" ? "connected" : status}
          {status === "error" && error ? ` · ${error}` : ""}
        </div>
      </CardContent>
    </Card>
  );
}