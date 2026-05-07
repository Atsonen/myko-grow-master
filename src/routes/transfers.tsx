import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useDataStore, dataActions } from "@/store/useDataStore";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TypeBadge } from "@/components/common/TypeBadge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { formatDateTime, relativeTime } from "@/lib/format";
import { Archive, ArchiveRestore, ArrowLeftRight, Pencil, PlusCircle } from "lucide-react";
import { toast } from "sonner";

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
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isChild = path !== "/transfers";

  return (
    <div className="p-4 space-y-4">
      {!isChild && <TransfersIndex />}
      <Outlet />
    </div>
  );
}

function TransfersIndex() {
  const { transfers, units } = useDataStore();
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const unitByCode = useMemo(() => new Map(units.map((u) => [u.code, u])), [units]);

  const visibleTransfers = transfers.filter((t) => showArchived || !t.archived);
  const filtered = [...visibleTransfers]
    .sort((a, b) => b.transferTime.localeCompare(a.transferTime))
    .filter((t) => {
      if (!q) return true;
      const source = unitByCode.get(t.sourceUnitCode);
      const target = unitByCode.get(t.targetUnitCode);
      const text = `${t.sourceUnitCode} ${t.targetUnitCode} ${t.method} ${t.amount} ${t.description ?? ""} ${t.note ?? ""} ${source?.strainCode ?? ""} ${target?.strainCode ?? ""}`.toLowerCase();
      return text.includes(q.toLowerCase());
    });
  const hiddenCount = transfers.filter((t) => t.archived).length;

  const toggleArchive = (id: string, archived?: boolean) => {
    if (archived) {
      dataActions.restoreTransfer(id);
      toast.success("Transfer restored");
    } else {
      dataActions.archiveTransfer(id);
      toast.success("Transfer archived");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search transfers, units, method, notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-sm h-8 font-mono text-xs"
        />
        <label className="flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">{filtered.length} / {visibleTransfers.length}{!showArchived ? ` (${hiddenCount} archived hidden)` : ""}</span>
          <Button size="sm" asChild>
            <Link to="/transfers/new"><PlusCircle className="h-3 w-3 mr-1" />Add transfer</Link>
          </Button>
        </div>
      </div>

      <Card className="bg-card border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/50 text-muted-foreground uppercase font-mono text-[10px]">
              <tr>
                <th className="text-left p-2">Transfer</th>
                <th className="text-left p-2">Source</th>
                <th className="text-left p-2">Target</th>
                <th className="text-left p-2">Method</th>
                <th className="text-left p-2">Amount</th>
                <th className="text-left p-2">Time</th>
                <th className="text-left p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const source = unitByCode.get(t.sourceUnitCode);
                const target = unitByCode.get(t.targetUnitCode);
                return (
                  <tr key={t.id} className={`border-t border-border hover:bg-secondary/40 ${t.archived ? "opacity-60" : ""}`}>
                    <td className="p-2 font-mono text-muted-foreground">
                      <div className="flex items-center gap-2"><ArrowLeftRight className="h-3 w-3" />{t.id}{t.archived ? " · ARCHIVED" : ""}</div>
                    </td>
                    <td className="p-2">
                      <UnitLink code={t.sourceUnitCode} type={source?.type} status={source?.status} />
                    </td>
                    <td className="p-2">
                      <UnitLink code={t.targetUnitCode} type={target?.type} status={target?.status} />
                    </td>
                    <td className="p-2">{t.method}</td>
                    <td className="p-2 text-muted-foreground">{t.amount}</td>
                    <td className="p-2 text-muted-foreground" title={formatDateTime(t.transferTime)}>{relativeTime(t.transferTime)}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <button onClick={() => toggleArchive(t.id, t.archived)} className="text-muted-foreground hover:text-primary" title={t.archived ? "Restore transfer" : "Archive transfer"}>
                          {t.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
                        </button>
                        <Link to="/transfers/$transferId/edit" params={{ transferId: t.id }} className="text-muted-foreground hover:text-primary">
                          <Pencil className="h-3 w-3" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted-foreground italic">No transfers match filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function UnitLink({ code, type, status }: { code: string; type?: string; status?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link to="/units/$unitCode" params={{ unitCode: code }} className="font-mono text-primary hover:underline">
        {code}
      </Link>
      {type && <TypeBadge type={type} />}
      {status && <StatusBadge status={status} />}
    </div>
  );
}
