import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  ACTIVE: "bg-status-active/15 text-status-active border-status-active/40",
  CONTAMINATED: "bg-status-contaminated/15 text-status-contaminated border-status-contaminated/40",
  DISCARDED: "bg-status-archived/15 text-status-archived border-status-archived/40",
  HARVESTED: "bg-status-harvested/15 text-status-harvested border-status-harvested/40",
  ARCHIVED: "bg-status-archived/15 text-status-archived border-status-archived/40",
};

const fallbackStyle = "bg-muted text-muted-foreground border-border";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider",
        styles[status] ?? fallbackStyle,
        className,
      )}
    >
      {status}
    </span>
  );
}
