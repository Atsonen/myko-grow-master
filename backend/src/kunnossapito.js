// Kunnossapito (maintenance knowledge base) client: MariaDB `kunnossapito` (incidents, actions, known_fixes, policy).
// Credentials are read at runtime from /home/atte/kunnossapito/.env (600, outside this repo, never logged).
// Used by the Telegram DeepSeek assistant (tgTools.js) and the auto-recovery watcher (autoRecovery.js).
import * as mariadb from "mariadb";
import { readFileSync } from "node:fs";

const KP_ENV = process.env.KP_ENV || "/home/atte/kunnossapito/.env";
function creds() {
  const e = Object.fromEntries(readFileSync(KP_ENV, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  return { host: e.KP_DB_HOST || "127.0.0.1", port: Number(e.KP_DB_PORT || 3306), database: e.KP_DB_NAME || "kunnossapito", user: e.KP_DB_USER, password: e.KP_DB_PASSWORD };
}
let pool;
const getPool = () => (pool ??= mariadb.createPool({ ...creds(), connectionLimit: 2, dateStrings: true, bigIntAsNumber: true, decimalAsNumber: true }));
export async function kq(sql, params = []) {
  const c = await getPool().getConnection();
  try { return await c.query(sql, params); } finally { c.release(); }
}
const j = (x) => { if (x == null) return null; if (typeof x === "object") return x; try { return JSON.parse(x); } catch { return x; } };
const low = (x) => (Array.isArray(x) ? x : x ? [x] : []).map((s) => String(s).toLowerCase());
/** Local Helsinki "YYYY-MM-DD HH:MM:SS" (the KB stores Helsinki local time). */
export const helNow = (d = new Date()) => d.toLocaleString("sv-SE", { timeZone: "Europe/Helsinki" }).slice(0, 19);

/** Pure matcher (same rules as kp.py match). fixes = known_fixes rows. */
export function matchFixes(sym, fixes) {
  const tags = new Set([...low(sym.conditions), ...low(sym.symptoms)]);
  const out = [];
  for (const f of fixes) {
    const t = j(f.trigger_conditions) ?? {};
    if (sym.system && t.system && String(sym.system).toLowerCase() !== String(t.system).toLowerCase()) continue;
    if (sym.device && t.devices && !low(t.devices).includes(String(sym.device).toLowerCase())) continue;
    const hit = [...new Set([...low(t.any_of), ...low(t.symptoms)])].filter((x) => tags.has(x));
    if (!hit.length) continue;
    const eligible = Boolean(Number(f.autonomy_allowed)) && Number(f.times_worked) >= 1;
    out.push({ fix_id: f.id, name: f.name, matched: hit.sort(), preconditions: f.preconditions, steps: j(f.steps), verification: f.verification,
      times_worked: Number(f.times_worked), autonomy_eligible: eligible,
      policy: eligible ? "ask user via Telegram first; act if no reply in 10 min; always notify" : "ask user; no autonomous action" });
  }
  return out.sort((a, b) => b.matched.length - a.matched.length);
}
export async function kpMatch(sym) { return matchFixes(sym, await kq("SELECT * FROM known_fixes")); }
export async function kpSearch(text) {
  const s = `%${String(text ?? "").slice(0, 100)}%`;
  return {
    incidents: await kq("SELECT id, ts_start, ts_end, `system`, device, status, symptom, root_cause, resolution FROM incidents WHERE CONCAT_WS(' ', `system`, device, symptom, conditions, root_cause, resolution) LIKE ? ORDER BY ts_start DESC LIMIT 30", [s]),
    known_fixes: await kq("SELECT id, name, times_worked, autonomy_allowed, preconditions, notes FROM known_fixes WHERE CONCAT_WS(' ', name, trigger_conditions, preconditions, steps, notes) LIKE ? LIMIT 20", [s]),
    actions: await kq("SELECT id, incident_id, ts, actor, action, result, worked FROM actions WHERE CONCAT_WS(' ', actor, action, nodes, params, result) LIKE ? ORDER BY ts DESC LIMIT 30", [s]),
  };
}
export async function kpShowIncident(id) {
  const [inc] = await kq("SELECT * FROM incidents WHERE id = ?", [Number(id)]);
  return inc ? { incident: inc, actions: await kq("SELECT * FROM actions WHERE incident_id = ? ORDER BY ts", [Number(id)]) } : { error: "ei löydy" };
}
export async function kpGetFix(id) { const [f] = await kq("SELECT * FROM known_fixes WHERE id = ?", [Number(id)]); return f ? { ...f, steps: j(f.steps), trigger_conditions: j(f.trigger_conditions) } : null; }
export async function kpListFixes() { return kq("SELECT id, name, times_worked, autonomy_allowed, preconditions, verification FROM known_fixes ORDER BY id"); }
export async function kpPolicy() { return kq("SELECT name, text FROM policy"); }
const STATUSES = ["open", "resolved", "info", "closed"];
export async function kpLogIncident(a) {
  if (!a?.system || !a?.symptom) throw new Error("system ja symptom pakollisia");
  const r = await kq("INSERT INTO incidents (ts_start, ts_end, `system`, device, symptom, conditions, root_cause, resolution, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [a.ts_start || helNow(), a.ts_end || null, String(a.system).slice(0, 32), a.device ? String(a.device).slice(0, 32) : null, String(a.symptom).slice(0, 4000),
      a.conditions ? JSON.stringify(a.conditions) : null, a.root_cause ?? null, a.resolution ?? null, STATUSES.includes(a.status) ? a.status : "open"]);
  return { id: Number(r.insertId) };
}
export async function kpUpdateIncident(id, a) {
  const sets = [], p = [];
  for (const k of ["ts_end", "root_cause", "resolution"]) if (a[k] !== undefined) { sets.push(`${k} = ?`); p.push(a[k]); }
  if (a.status && STATUSES.includes(a.status)) { sets.push("status = ?"); p.push(a.status); }
  if (!sets.length) return { id };
  await kq(`UPDATE incidents SET ${sets.join(", ")} WHERE id = ?`, [...p, Number(id)]);
  return { id };
}
export async function kpLogAction(a) {
  if (!a?.actor || !a?.action) throw new Error("actor ja action pakollisia");
  const r = await kq("INSERT INTO actions (incident_id, ts, actor, action, nodes, params, approved_by, result, worked, known_fix_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [a.incident_id ?? null, a.ts || helNow(), String(a.actor).slice(0, 64), String(a.action).slice(0, 2000), a.nodes ?? null, a.params ? JSON.stringify(a.params) : null,
      a.approved_by ?? null, a.result ?? null, a.worked == null ? null : a.worked ? 1 : 0, a.known_fix_id ?? null]);
  return { id: Number(r.insertId) };
}
export async function kpFixWorked(fixId) { await kq("UPDATE known_fixes SET times_worked = times_worked + 1 WHERE id = ?", [Number(fixId)]); }
