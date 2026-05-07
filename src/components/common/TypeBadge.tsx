import { cn } from "@/lib/utils";
import type { ContainerType } from "@/types";

export function TypeBadge({ type, className }: { type: ContainerType; className?: string }) {
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