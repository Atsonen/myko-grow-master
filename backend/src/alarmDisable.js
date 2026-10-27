// Hälytysten väliaikainen poiskytkentä (27.10.2026): aina aikaraja (oletus 1 h, max 7 vrk), ei pysyvää poiskytkentää.
// disabled_until tallennetaan myko_settings-asetukseen (säilyy uudelleenkäynnistyksen yli); moottorit kytkevät takaisin.
import { query } from "./db.js";
export const DIS_DEFAULT_MIN = 60, DIS_MAX_MIN = 7 * 24 * 60;
export function disableMinutes(v) {
  if (v === undefined || v === null || v === "") return DIS_DEFAULT_MIN;
  const m = Number(v); if (!Number.isFinite(m) || m < 1 || m > DIS_MAX_MIN) throw new Error(`poiskytkennän kesto 1 min – 7 vrk`);
  return Math.round(m);
}
export function untilTxt(iso) {
  const d = new Date(iso); const o = { timeZone: "Europe/Helsinki" };
  const day = (x) => x.toLocaleDateString("fi-FI", o);
  const t = d.toLocaleTimeString("fi-FI", { ...o, hour: "2-digit", minute: "2-digit" });
  return day(d) === day(new Date()) ? `klo ${t}` : `${d.toLocaleDateString("fi-FI", { ...o, day: "numeric", month: "numeric" })} klo ${t}`;
}
let ready = null;
export async function logToggle(alarm, action, until, by) {
  ready ??= query(`CREATE TABLE IF NOT EXISTS alarm_disable_log (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ts DATETIME NOT NULL,
    alarm VARCHAR(40) NOT NULL, action VARCHAR(16) NOT NULL, until_ts DATETIME NULL, by_who VARCHAR(80) NULL, INDEX (ts)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  try { await ready; await query("INSERT INTO alarm_disable_log (ts, alarm, action, until_ts, by_who) VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?)", [alarm, action, until ? new Date(until).toISOString().slice(0, 19).replace("T", " ") : null, String(by ?? "").slice(0, 80)]); }
  catch (e) { console.warn("[alarmdisable] log", e.message); }
  console.log(`[alarmdisable] ${alarm} ${action}${until ? " until " + until : ""} by ${by}`);
}
