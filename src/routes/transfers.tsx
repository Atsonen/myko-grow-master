import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/transfers")({
  head: () => ({
    meta: [
      { title: "Transfers — Myko Valvomo" },
      { name: "description", content: "Structured source-to-target cultivation transfers." },
    ],
  }),
  component: TransfersLayout,
});

function TransfersLayout() {
  return <Outlet />;
}
