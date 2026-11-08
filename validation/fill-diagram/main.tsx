import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardDataProvider } from "@/components/dashboard/DashboardData";
import { ProcessDiagramWidget } from "@/components/dashboard/ProcessDiagramWidget";
import "@/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="dark flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <div id="syn-banner" className="shrink-0 bg-orange-800 px-3 py-2 font-mono text-sm text-orange-50">
        SYNTEETTINEN DATA · ei tuotantoa · Europe/Helsinki
      </div>
      <div className="min-h-0 flex-1">
        <DashboardDataProvider>
          <ProcessDiagramWidget />
        </DashboardDataProvider>
      </div>
    </div>
  </StrictMode>,
);
