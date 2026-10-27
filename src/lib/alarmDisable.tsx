// Hälytyksen väliaikainen poiskytkentä: aina aikaraja (oletus 1 h, max 7 vrk). Backend kytkee takaisin automaattisesti.
import { useEffect, useState } from "react";
import { putFertDoseSettings, putKasvamoAlarms } from "@/lib/apiClient";

export const DIS_CHOICES: [number, string][] = [[30, "30 min"], [60, "1 h"], [240, "4 h"], [720, "12 h"], [1440, "24 h"]];
export const DIS_MAX_MIN = 7 * 24 * 60;

export function untilLabel(iso: string, now = Date.now()) {
  const d = new Date(iso); const left = Math.max(0, d.getTime() - now);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const t = d.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
  const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000);
  return `pois ${sameDay ? "" : d.toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" }) + " "}klo ${t} asti (${h ? `${h} h ` : ""}${m} min)`;
}
export function useNow(ms = 30_000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return n;
}
export async function reEnableAlarm(kind: "fert" | "kasvamo", key: string) {
  if (kind === "fert") return putFertDoseSettings({ ec_alarm: { enabled: true } });
  return putKasvamoAlarms(key === "all" ? { enabled: true } as never : { limits: { [key]: { enabled: true } } });
}

/** Kesto-valinta poiskytkennälle. value = minuutit. */
export function DisableDuration({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  const preset = DIS_CHOICES.some(([m]) => m === value);
  const [custom, setCustom] = useState(!preset);
  const [txt, setTxt] = useState(String(value));
  return (
    <div className="space-y-1 text-xs" data-testid="dis-duration">
      <div className="text-muted-foreground">Kytketään automaattisesti takaisin päälle:</div>
      <div className="flex flex-wrap gap-1">
        {DIS_CHOICES.map(([m, l]) => (
          <button key={m} type="button" onClick={() => { setCustom(false); onChange(m); }}
            className={`rounded border px-2 py-1 ${!custom && value === m ? "border-sky-500 bg-sky-600 text-white" : "border-border"}`}>{l}</button>
        ))}
        <button type="button" onClick={() => setCustom(true)} className={`rounded border px-2 py-1 ${custom ? "border-sky-500 bg-sky-600 text-white" : "border-border"}`}>Muu…</button>
      </div>
      {custom && (
        <label className="flex items-center gap-2">Tunteja
          <input className="w-20 rounded border border-border bg-background px-2 py-1 font-mono" value={txt}
            onChange={(e) => { setTxt(e.target.value); const h = Number(e.target.value.replace(",", ".")); if (h > 0) onChange(Math.min(DIS_MAX_MIN, Math.round(h * 60))); }} />
          <span className="text-muted-foreground">(max 168 h = 7 vrk)</span></label>
      )}
    </div>
  );
}
