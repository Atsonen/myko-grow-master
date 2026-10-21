import { useEffect, useState } from "react";
import { getDataloggerLatest, type DataloggerLatest } from "@/lib/apiClient";
import { relativeTime } from "@/lib/format";
import {
  BIT_ALARM_COLOR,
  BIT_OFF_DEFAULT,
  BIT_ON_DEFAULT,
  bitState,
  dlLabel,
  useDataloggerVariables,
  wordTooltip,
} from "@/lib/statusBits";
import { useDashboardData } from "./DashboardData";
import type { WidgetConfigMap } from "./types";

/** Lamp grid for the bits of one datalogger status word. Bit names/colors come from the
 *  variable's global bit definitions (Settings page); config.bits optionally limits the subset. */
export function StatusBitsWidget({ config }: { config: WidgetConfigMap["statusBits"] }) {
  const { tick } = useDashboardData();
  const variables = useDataloggerVariables();
  const [latest, setLatest] = useState<DataloggerLatest | null>(null);
  const [err, setErr] = useState("");
  const key = config.variableKey;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    getDataloggerLatest([key])
      .then((r) => { if (!cancelled) { setLatest(r[0] ?? null); setErr(""); } })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => { cancelled = true; };
  }, [key, tick]);

  if (!key) return <div className="text-xs text-muted-foreground italic">Pick a status word in widget settings.</div>;
  const v = variables.find((x) => x.variableKey === key);
  if (!v) return <div className="text-xs text-muted-foreground italic">Loading…</div>;
  const defs = v.bits.filter((b) => !config.bits?.length || config.bits.includes(b.bit));
  const staleMin = config.staleMinutes ?? 10;
  const ageMin = latest?.timestamp ? (Date.now() - new Date(latest.timestamp).getTime()) / 60_000 : Infinity;
  const stale = ageMin > staleMin;
  const raw = latest?.raw;

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden" title={wordTooltip(raw)} data-testid="status-bits">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono" data-testid="status-word-raw">{dlLabel(v)} = {raw ?? "—"}</span>
        {stale && (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] text-amber-400" data-testid="stale">
            stale{latest?.timestamp ? ` · ${relativeTime(latest.timestamp)}` : ""}
          </span>
        )}
        {err && <span className="text-destructive">{err}</span>}
      </div>
      {defs.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">No bits defined for this word — define them in Settings.</div>
      ) : (
        <div className="grid flex-1 content-start gap-2 overflow-y-auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
          {defs.map((d) => {
            const on = bitState(raw, d);
            const color = on ? (d.alarm ? BIT_ALARM_COLOR : d.onColor || BIT_ON_DEFAULT) : d.offColor || BIT_OFF_DEFAULT;
            return (
              <div
                key={d.bit}
                data-bit={d.bit}
                data-on={on ? "1" : "0"}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${stale ? "opacity-50" : ""} ${on && d.alarm ? "border-red-500 animate-pulse" : "border-border"}`}
                title={`bit ${d.bit}${d.invert ? " (inverted)" : ""}: ${on === null ? "no value" : on ? "ON" : "off"} · ${wordTooltip(raw)}`}
              >
                <span className="h-4 w-4 shrink-0 rounded-full" style={{ background: color, boxShadow: on ? `0 0 8px ${color}` : undefined }} />
                <span className="truncate text-sm">{d.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
