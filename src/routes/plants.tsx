import { createFileRoute, Link } from "@tanstack/react-router";
import { Sprout, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/plants")({
  head: () => ({ meta: [{ title: "Plants - Myko Valvomo" }] }),
  component: PlantsPage,
});

function PlantsPage() {
  return (
    <div className="p-4 space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-mono flex items-center gap-2">
          <Sprout className="h-4 w-4" /> Plants
        </h1>
        <Button asChild size="sm" variant="secondary">
          <Link to="/plants/trends">
            <TrendingUp className="h-3 w-3 mr-1" /> Trends
          </Link>
        </Button>
      </div>

      <Card className="p-4 bg-card border-border">
        <div className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
          Plant workspace
        </div>
        <div className="mt-2 text-xs text-muted-foreground leading-relaxed">
          Plant views use the same MariaDB measurements and Datalogger variables as Myko, but trend
          presets are saved separately for plant workflows.
        </div>
      </Card>
    </div>
  );
}
