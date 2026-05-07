import { cn } from "@/lib/utils";

export function TypeBadge({ type, className }: { type: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded border border-border bg-muted text-muted-foreground text-[10px] font-mono uppercase tracking-wider",
        className,
      )}
    >
      +{type}
    </span>
  );
}
