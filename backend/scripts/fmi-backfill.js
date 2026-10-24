// Backfill fmi_weather_obs in 7-day chunks (FMI limit 168 h/query). Usage: node scripts/fmi-backfill.js [2016-01-01] [end]
// Resumable: skips weeks already having >=150 rows. ~1 req/s to stay well under FMI limits.
import { query, closeDb } from "../src/db.js";
import { TABLES, fetchObs } from "../src/fmiWeather.js";
const start = new Date((process.argv[2] ?? "2016-01-01") + "T00:00:00Z");
const end = process.argv[3] ? new Date(process.argv[3] + "T00:00:00Z") : new Date();
for (const s of TABLES) await query(s);
const WEEK = 7 * 864e5;
let total = 0;
for (let t = start.getTime(); t < end.getTime(); t += WEEK) {
  const a = new Date(t), b = new Date(Math.min(t + WEEK - 3600_000, end.getTime()));
  const [{ c }] = await query("SELECT COUNT(*) c FROM fmi_weather_obs WHERE obs_time BETWEEN ? AND ?", [a, b]);
  if (Number(c) >= 150) continue;
  for (let attempt = 0; ; attempt++) {
    try { const n = await fetchObs(query, a, b); total += n; console.log(a.toISOString().slice(0, 10), n); break; }
    catch (e) { console.error(a.toISOString().slice(0, 10), e.message); if (attempt >= 3) break; await new Promise((r) => setTimeout(r, 10_000)); }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log("done, rows", total);
await closeDb?.();
process.exit(0);
