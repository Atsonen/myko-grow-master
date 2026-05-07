import { cn } from "@/lib/utils";

export function IdentifierTag({ value, className }: { value: string; className?: string }) {
  return (
    <code
      className={cn(
        "inline-block font-mono text-xs leading-tight px-2 py-1 rounded bg-secondary text-secondary-foreground border border-border break-all",
        className,
      )}
    >
      {value}
    </code>
  );
}