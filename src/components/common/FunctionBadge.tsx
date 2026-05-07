import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  COL: "bg-primary/15 text-primary border-primary/40",
  FRU: "bg-status-harvested/15 text-status-harvested border-status-harvested/40",
  OBS: "bg-muted text-muted-foreground border-border",
  QC: "bg-status-warning/15 text-status-warning border-status-warning/40",
  TRF: "bg-accent text-accent-foreground border-border",
  HAR: "bg-status-harvested/15 text-status-harvested border-status-harvested/40",
  PREP: "bg-secondary text-secondary-foreground border-border",
};

const fallbackStyle = "bg-secondary text-secondary-foreground border-border";

export function FunctionBadge({ code, className }: { code: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider",
        styles[code] ?? fallbackStyle,
        className,
      )}
    >
      ={code}
    </span>
  );
}
