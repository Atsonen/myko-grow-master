import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Database, Download, FileJson, RefreshCcw, Upload } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/data")({
  head: () => ({ meta: [{ title: "Data management — Myko Valvomo" }] }),
  component: DataPage,
});

function DataPage() {
  const { strains, units, events, transfers, taxonomy } = useDataStore();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [lastImportName, setLastImportName] = useState<string>("");

  const exportJson = () => {
    const payload = dataActions.exportState();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `myko-valvomo-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("Backup exported");
  };

  const importJson = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      dataActions.importState(parsed);
      setLastImportName(file.name);
      toast.success("Backup imported");
    } catch (error) {
      toast.error(`Import failed: ${(error as Error).message}`);
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const reset = () => {
    if (!confirm("Reset all local data to mock data? This overwrites the current browser state.")) return;
    dataActions.resetToMockData();
    toast.success("Local data reset to mock data");
  };

  return (
    <div className="p-4 space-y-4 max-w-4xl">
      <div>
        <h1 className="text-lg font-mono flex items-center gap-2"><Database className="h-4 w-4" /> Data management</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Current MVP data is stored in this browser with localStorage. This is intentionally local-only until the MariaDB/API backend is added.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Strains" value={strains.length} />
        <Stat label="Units" value={units.length} />
        <Stat label="Events" value={events.length} />
        <Stat label="Transfers" value={transfers.length} />
      </div>

      <Card className="p-4 bg-card border-border space-y-4">
        <div>
          <h2 className="text-sm font-mono uppercase tracking-wider">Backup / restore</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Export before larger edits. Import replaces the current in-browser state with the selected JSON backup.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportJson}><Download className="h-4 w-4 mr-2" />Export JSON</Button>
          <Button variant="secondary" onClick={() => inputRef.current?.click()}><Upload className="h-4 w-4 mr-2" />Import JSON</Button>
          <Button variant="ghost" onClick={reset}><RefreshCcw className="h-4 w-4 mr-2" />Reset to mock data</Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importJson(file);
          }}
        />
        {lastImportName && <div className="text-xs text-muted-foreground">Last imported: {lastImportName}</div>}
      </Card>

      <Card className="p-4 bg-card border-border space-y-3">
        <div className="flex items-center gap-2">
          <FileJson className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-mono uppercase tracking-wider">Current taxonomy</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <TaxonomyList title="Functions" values={taxonomy.functions} prefix="=" />
          <TaxonomyList title="Types" values={taxonomy.types} prefix="+" />
          <TaxonomyList title="Statuses" values={taxonomy.statuses} />
          <TaxonomyList title="QC tags" values={taxonomy.qcTags} />
        </div>
      </Card>

      <Card className="p-4 bg-secondary/20 border-border">
        <div className="text-sm font-medium">Important limitation</div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          localStorage is per browser and per device. It is good for testing the workflow, but it is not a shared database. The next backend step is Node/Express API + MariaDB on Lubuntu.
        </p>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card rounded border border-border p-3">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-mono">{value}</div>
    </div>
  );
}

function TaxonomyList({ title, values, prefix = "" }: { title: string; values: string[]; prefix?: string }) {
  return (
    <div className="border border-border rounded p-3 bg-secondary/20">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">{title}</div>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <span key={value} className="inline-flex rounded border border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {prefix}{value}
          </span>
        ))}
      </div>
    </div>
  );
}
