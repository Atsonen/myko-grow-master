import { useEffect, useState } from "react";
import { getDataloggerVariables, type DataloggerVariable, type StatusBitDef } from "@/lib/apiClient";

export const BIT_ON_DEFAULT = "#22c55e";
export const BIT_OFF_DEFAULT = "#3f3f46";
export const BIT_ALARM_COLOR = "#ef4444";

/** Bit state after optional inversion; null when no value. */
export function bitState(raw: number | null | undefined, def: Pick<StatusBitDef, "bit" | "invert">): boolean | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
  const on = ((Math.trunc(raw) >>> def.bit) & 1) === 1;
  return def.invert ? !on : on;
}

export function wordTooltip(raw: number | null | undefined) {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return "no value";
  const n = Math.trunc(raw) >>> 0;
  const bin = n.toString(2).padStart(16, "0").replace(/(.{4})(?=.)/g, "$1 ");
  return `${n} · 0x${n.toString(16).toUpperCase().padStart(4, "0")} · ${bin}`;
}

export function dlLabel(v: Pick<DataloggerVariable, "position" | "name" | "displayName">) {
  return `Datalogger ${String(v.position).padStart(2, "0")} - ${v.displayName || v.name}`;
}

/* shared, refreshable cache of datalogger variables */
let cache: DataloggerVariable[] | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
export function reloadDataloggerVariables() {
  inflight = getDataloggerVariables()
    .then((v) => { cache = v; })
    .catch(() => { cache = cache ?? []; })
    .finally(() => listeners.forEach((l) => l()));
  return inflight;
}
export function useDataloggerVariables() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    if (!inflight) void reloadDataloggerVariables();
    return () => { listeners.delete(l); };
  }, []);
  return cache ?? [];
}
