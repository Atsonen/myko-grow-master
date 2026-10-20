import { createFileRoute } from "@tanstack/react-router";
import { TrendsPage } from "@/routes/trends";

export const Route = createFileRoute("/plants/trends")({
  head: () => ({ meta: [{ title: "Plant trends - Myko Valvomo" }] }),
  component: () => <TrendsPage workspace="plants" />,
});
