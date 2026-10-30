import { createFileRoute } from "@tanstack/react-router";
import { CustomDashboard } from "@/components/dashboard/DashboardGrid";
import { PLANTS_DEFAULT_LAYOUT } from "@/components/dashboard/types";

export const Route = createFileRoute("/plants/dashboard")({
  head: () => ({ meta: [{ title: "Plants dashboard - Myko Valvomo" }] }),
  component: PlantsDashboardRoute,
});

function PlantsDashboardRoute() {
  return (
    <CustomDashboard
      layoutId="plants"
      defaultLayout={PLANTS_DEFAULT_LAYOUT}
      title="Kasvamo – prosessinäkymä"
      titleIcon="gauge"
    />
  );
}
