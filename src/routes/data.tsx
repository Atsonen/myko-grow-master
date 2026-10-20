import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Database, Download, FileJson, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";
import { getDbState, getStateSummary, getTaxonomy, importStateToDb, type ImportMode, type StateSummary } from "@/lib/apiClient";
import type { Taxonomy } from "@/store/useDataStore";

export const Route = createFileRoute("/data")({
  head: () => ({ meta: [{ title: "Data management — Myko Valvomo" }] }),
  component: DataPage,
});

function DataPage() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [lastImportName, setLastImportName] = useState<string>("");
  const [summary, setSummary] = useState<StateSummary | null>(null);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>({ functions: [], types: [], statuses: [], qcTags: [] });
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [importMode, setImportMode] = useState<ImportMode>("upsert");
  const [dbBusy, setDbBusy] = useState(false);

  const refresh = async () => {
    setStatus("loading");
    try {
      const [nextSummary, nextTaxonomy] = await Promise.all([getStateSummary(), getTaxonomy()]);
      setSummary(nextSummary);
      setTaxonomy(nextTaxonomy);
      setStatus("ok");
      setError("");
    } catch (err) {
      setStatus("error");
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const exportDbJson = async () => {
    const payload = await getDbState();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `myko-valvomo-db-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("MariaDB backup exported");
  };

  const importJson = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      setDbBusy(true);
      const result = await importStateToDb(parsed, importMode);
      setLastImportName(file.name);
      await refresh();
      toast.success(`Imported to MariaDB: ${result.counts.units} units, ${result.counts.events} events`);
    } catch (error) {
      toast.error(`Import failed: ${(error as Error).message}`);
    } finally {
      setDbBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const openImport = (mode: ImportMode) => {
    const message = mode === "replace"
      ? "Import JSON to MariaDB with replace? This clears strains, units, events, transfers and taxonomy first. Sensor readings are not cleared."
      : "Import JSON to MariaDB with upsert? Existing matching rows are updated and sensor readings are not touched.";
    if (!confirm(message)) return;
    setImportMode(mode);
    inputRef.current?.click();
  };

  return (
    <div className="p-4 space-y-4 max-w-4xl">
      <div>
        <h1 className="text-lg font-mono flex items-center gap-2"><Database className="h-4 w-4" /> Data management</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Data is stored in MariaDB through the Lubuntu backend. Browser localStorage is not the official data source.
        </p>
      </div>

      {status === "error" && <ApiError message={error} />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Strains" value={summary?.counts.strains ?? 0} />
        <Stat label="Units" value={summary?.counts.units ?? 0} />
        <Stat label="Events" value={summary?.counts.events ?? 0} />
        <Stat label="Transfers" value={summary?.counts.transfers ?? 0} />
      </div>

      <Card className="p-4 bg-card border-border space-y-4">
        <div>
          <h2 className="text-sm font-mono uppercase tracking-wider">MariaDB import / export</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Import accepts the existing JSON backup format. Replace clears only Myko master tables, not environment sensor readings.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportDbJson} disabled={dbBusy || status === "error"}><Download className="h-4 w-4 mr-2" />Export DB JSON</Button>
          <Button variant="secondary" disabled={dbBusy} onClick={() => openImport("upsert")}><Upload className="h-4 w-4 mr-2" />Import JSON upsert</Button>
          <Button variant="secondary" disabled={dbBusy} onClick={() => openImport("replace")}><Upload className="h-4 w-4 mr-2" />Import JSON replace</Button>
          <Button variant="outline" disabled={dbBusy} onClick={refresh}><RefreshCw className="h-4 w-4 mr-2" />Refresh DB counts</Button>
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
        <div className="text-xs text-muted-foreground">
          API status: {status === "ok" ? "connected" : status === "loading" ? "checking" : "unavailable"}
          {lastImportName ? ` · Last imported: ${lastImportName}` : ""}
        </div>
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
    </div>
  );
}

function ApiError({ message }: { message: string }) {
  return (
    <Card className="p-4 border-destructive/40 bg-destructive/10">
      <div className="text-sm font-medium">DB/API unavailable</div>
      <div className="text-xs text-muted-foreground mt-1">{message}</div>
    </Card>
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
