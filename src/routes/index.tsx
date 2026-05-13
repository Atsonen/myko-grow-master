import { createFileRoute, Link } from "@tanstack/react-router";
import { useDataStore } from "@/store/useDataStore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/StatusBadge";
import { FunctionBadge } from "@/components/common/FunctionBadge";
import { TypeBadge } from "@/components/common/TypeBadge";
import { relativeTime } from "@/lib/format";
import type { ContainerType } from "@/types";
import { AlertTriangle, Box, Activity, Clock, ArrowLeftRight } from "lucide-react";
import { LatestTemperaturesCard } from "@/components/dashboard/LatestTemperaturesCard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Myko Valvomo" },
      { name: "description", content: "Live overview of active units, contamination warnings, and recent activity." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const store = useDataStore();
  const units = store.units.filter((u) => u.status !== "ARCHIVED");
  const events = store.events.filter((e) => !e.archived && units.some((u) => u.code === e.unitCode));
  const transfers = store.transfers.filter((t) => !t.archived && units.some((u) => u.code === t.sourceUnitCode || u.code === t.targetUnitCode));

  const activeUnits = units.filter((u) => u.status === "ACTIVE");
  const activeBoxes = activeUnits.filter((u) => u.type === "BOX");
  const contaminated = units.filter((u) => u.status === "CONTAMINATED");

  const recentObservations = [...events]
    .filter((e) => e.functionCode === "OBS")
    .sort((a, b) => b.eventTime.localeCompare(a.eventTime))
    .slice(0, 5);

  const qcWarnings = [...events]
    .filter((e) => e.functionCode === "QC")
    .sort((a, b) => b.eventTime.localeCompare(a.eventTime))
    .slice(0, 5);

  const recentTransfers = [...transfers]
    .sort((a, b) => b.transferTime.localeCompare(a.transferTime))
    .slice(0, 5);

  const lastEventByUnit = new Map<string, string>();
  for (const e of events) {
    const prev = lastEventByUnit.get(e.unitCode);
    if (!prev || e.eventTime > prev) lastEventByUnit.set(e.unitCode, e.eventTime);
  }
  const staleUnits = activeUnits
    .filter((u) => {
      const last = lastEventByUnit.get(u.code) ?? u.batchTime;
      return Date.now() - new Date(last).getTime() > 7 * 24 * 3600 * 1000;
    })
    .slice(0, 8);

  const byType = (["LC", "JAR", "PD", "BOX", "BAG", "OTHER"] as ContainerType[]).map((t) => ({
    type: t,
    count: activeUnits.filter((u) => u.type === t).length,
  }));

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile icon={<Activity className="h-4 w-4" />} label="Active units" value={activeUnits.length} />
        <StatTile icon={<Box className="h-4 w-4" />} label="Active boxes" value={activeBoxes.length} />
        <StatTile icon={<AlertTriangle className="h-4 w-4 text-status-contaminated" />} label="Contaminated" value={contaminated.length} accent="contaminated" />
        <StatTile icon={<Clock className="h-4 w-4 text-status-warning" />} label="Stale (7d+)" value={staleUnits.length} accent="warning" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <LatestTemperaturesCard />

        <Card className="bg-card border-border">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
              Active by type
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-2">
            {byType.map((b) => (
              <div key={b.type} className="border border-border rounded p-2 flex items-center justify-between">
                <TypeBadge type={b.type} />
                <span className="font-mono text-lg">{b.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="py-3 flex-row items-center justify-between">
            <CardTitle className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
              Active grow boxes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {activeBoxes.length === 0 && <Empty />}
            {activeBoxes.map((u) => (
              <Link
                key={u.code}
                to="/units/$unitCode"
                params={{ unitCode: u.code }}
                className="flex items-center justify-between text-xs p-2 rounded hover:bg-secondary border border-transparent hover:border-border"
              >
                <span className="font-mono">{u.code}</span>
                <span className="text-muted-foreground">#{u.strainCode}</span>
                <StatusBadge status={u.status} />
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
              Contamination warnings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {qcWarnings.length === 0 && <Empty />}
            {qcWarnings.map((e) => (
              <Link key={e.id} to="/units/$unitCode" params={{ unitCode: e.unitCode }} className="flex items-start gap-2 text-xs p-2 rounded hover:bg-secondary border border-transparent hover:border-border">
                <FunctionBadge code={e.functionCode} />
                <div className="flex-1 min-w-0"><div className="font-mono truncate">{e.unitCode}</div><div className="text-muted-foreground truncate">{e.title}</div></div>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">{relativeTime(e.eventTime)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="py-3"><CardTitle className="text-sm font-mono uppercase tracking-wider text-muted-foreground">Recent observations</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {recentObservations.length === 0 && <Empty />}
            {recentObservations.map((e) => (
              <Link key={e.id} to="/units/$unitCode" params={{ unitCode: e.unitCode }} className="flex items-start gap-2 text-xs p-2 rounded hover:bg-secondary border border-transparent hover:border-border">
                <FunctionBadge code={e.functionCode} />
                <div className="flex-1 min-w-0"><div className="font-mono truncate">{e.unitCode}</div><div className="text-muted-foreground truncate">{e.title}</div></div>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">{relativeTime(e.eventTime)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="py-3"><CardTitle className="text-sm font-mono uppercase tracking-wider text-muted-foreground">Stale units (no update 7d+)</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {staleUnits.length === 0 && <Empty />}
            {staleUnits.map((u) => (
              <Link key={u.code} to="/units/$unitCode" params={{ unitCode: u.code }} className="flex items-center justify-between text-xs p-2 rounded hover:bg-secondary border border-transparent hover:border-border">
                <span className="font-mono">{u.code}</span><TypeBadge type={u.type} /><span className="text-[10px] text-muted-foreground">{relativeTime(lastEventByUnit.get(u.code) ?? u.batchTime)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="py-3"><CardTitle className="text-sm font-mono uppercase tracking-wider text-muted-foreground">Recent transfers</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {recentTransfers.length === 0 && <Empty />}
            {recentTransfers.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-xs p-2 rounded border border-border bg-secondary/30">
                <ArrowLeftRight className="h-3 w-3 text-muted-foreground" /><span className="font-mono">{t.sourceUnitCode}</span><span className="text-muted-foreground">→</span><span className="font-mono">{t.targetUnitCode}</span><span className="ml-auto text-[10px] text-muted-foreground">{relativeTime(t.transferTime)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Empty() { return <div className="text-xs text-muted-foreground italic px-2 py-3">— no entries —</div>; }

function StatTile({ label, value, icon, accent }: { label: string; value: number | string; icon: React.ReactNode; accent?: "contaminated" | "warning"; }) {
  const accentClass = accent === "contaminated" ? "border-status-contaminated/40" : accent === "warning" ? "border-status-warning/40" : "border-border";
  return <div className={`bg-card rounded border ${accentClass} p-3`}><div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{icon}{label}</div><div className="mt-1 text-2xl font-mono">{value}</div></div>;
}
