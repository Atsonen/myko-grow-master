// DB + action tools for the Telegram DeepSeek assistant (function calling).
// Read-only Myko DB (myko_ro) + kunnossapito KB + whitelisted writes via tgActions.js (Atte chat only).
// Credentials: /home/atte/.config/myko/db_ro.env (600, never logged). SQL guards: single SELECT/WITH/SHOW/
// DESCRIBE/EXPLAIN, row limit, max_statement_time. Audits: tg_ai_queries.log; writes: tg_writes.log.
// SensorBlock / ESP commands are NOT exposed.
import * as mariadb from "mariadb";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { kpSearch, kpShowIncident, kpMatch, kpListFixes, kpPolicy, kpLogIncident, kpLogAction, kpRecentIncidents, kpCandidates, kpStats } from "./kunnossapito.js";
import { WRITE_TOOLS, callWriteTool, isWriteTool, describeWrite } from "./tgActions.js";

const RO_FILE = process.env.MYKO_DB_RO_ENV || "/home/atte/.config/myko/db_ro.env";
const AUDIT_DIR = "/home/atte/.local/state/myko";
const MAX_ROWS = 500, MAX_CHARS = 12_000, STMT_TIMEOUT_S = 10;
const TZ = "Europe/Helsinki";

function roCreds() {
  const t = readFileSync(RO_FILE, "utf8");
  return { user: t.match(/^DB_RO_USER=(.+)$/m)?.[1].trim(), password: t.match(/^DB_RO_PASSWORD=(.+)$/m)?.[1].trim() };
}
let pool;
function getPool() {
  if (!pool) pool = mariadb.createPool({ host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || "myko_valvomo", ...roCreds(), connectionLimit: 2, timezone: "Z",
    dateStrings: true, bigIntAsNumber: true, decimalAsNumber: true });
  return pool;
}
async function roQuery(sql, params = []) {
  const c = await getPool().getConnection();
  try {
    await c.query(`SET SESSION max_statement_time=${STMT_TIMEOUT_S}, SESSION tx_read_only=1, SESSION time_zone='+00:00'`);
    return await c.query(sql, params);
  } finally { c.release(); }
}
export function audit(entry) {
  try { mkdirSync(AUDIT_DIR, { recursive: true }); appendFileSync(`${AUDIT_DIR}/tg_ai_queries.log`, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); } catch {}
}

/** Validate + bound a user/LLM SQL string. Throws on anything not plainly read-only. */
export function guardSql(sql) {
  let s = String(sql ?? "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(--\s|#)[^\n]*/g, " ").trim().replace(/;\s*$/, "");
  if (!s) throw new Error("tyhjä kysely");
  if (s.includes(";")) throw new Error("vain yksi lause sallittu");
  const kw = s.split(/\s+/)[0].toUpperCase();
  if (!["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(kw)) throw new Error("vain SELECT/WITH/SHOW/DESCRIBE sallittu");
  if (/\b(INTO\s+(OUT|DUMP)FILE|INTO\s+@|FOR\s+UPDATE|LOCK\s+IN|SLEEP\s*\(|BENCHMARK\s*\(|LOAD_FILE\s*\(|GET_LOCK\s*\(|INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|GRANT|SET\s+@|CALL|HANDLER)\b/i.test(s))
    throw new Error("kielletty avainsana");
  if (kw === "SELECT" || kw === "WITH") s = `SELECT * FROM (${s}) AS _q LIMIT ${MAX_ROWS}`;
  return s;
}
function pack(rows, note) {
  const arr = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : rows;
  let j = JSON.stringify({ rows: arr, count: Array.isArray(rows) ? rows.length : undefined, note });
  if (j.length > MAX_CHARS) j = j.slice(0, MAX_CHARS) + `…[katkaistu, ${Array.isArray(rows) ? rows.length : "?"} riviä; käytä aggregointia]`;
  return j;
}
// Local (Helsinki) "YYYY-MM-DD HH:MM[:SS]" -> SQL expr param; default = relative
const LOCAL = (p) => `CONVERT_TZ(${p}, '${TZ}', 'UTC')`;
const toLocal = (col) => `DATE_FORMAT(CONVERT_TZ(${col}, 'UTC', '${TZ}'), '%Y-%m-%d %H:%i')`;
function range(a) {
  const from = a.from || null, to = a.to || null;
  return { fromSql: from ? LOCAL("?") : "UTC_TIMESTAMP() - INTERVAL 24 HOUR", toSql: to ? LOCAL("?") : "UTC_TIMESTAMP()", params: [from, to].filter(Boolean) };
}

const PID_COLS = { pv: "pv", sp: "sp", out: "out_sum", out_heat: "out_heat", out_cool: "out_cool", outdoor: "outdoor_temp" };
async function getMeasurements(a) {
  const tags = (Array.isArray(a.tags) ? a.tags : [a.tags]).filter(Boolean).slice(0, 12);
  const agg = a.aggregate || "minmax"; const out = {};
  for (const tag of tags) {
    const r = range(a); let base, valCol, tCol, params;
    if (/^dl\d\d$/i.test(tag)) { base = "datalogger_values WHERE source_id='src-datalogger' AND variable_key=?"; valCol = "numeric_value"; tCol = "timestamp"; params = [tag.toLowerCase()]; }
    else if (/^(F1|T1|G_Air)(\.(pv|sp|out|out_heat|out_cool|outdoor))?$/i.test(tag)) {
      const [k, f = "pv"] = tag.split("."); const key = { f1: "F1", t1: "T1", g_air: "G_Air" }[k.toLowerCase()];
      base = "pid_training_log WHERE pid_key=?"; valCol = PID_COLS[f.toLowerCase()]; tCol = "at"; params = [key];
    } else if (/^outdoor$/i.test(tag)) {
      base = "(SELECT w1.forecast_time, w1.air_temperature FROM weather_metno w1 JOIN (SELECT forecast_time ft, MAX(id) mid FROM weather_metno GROUP BY forecast_time) l ON w1.id=l.mid) w WHERE 1"; valCol = "air_temperature"; tCol = "forecast_time"; params = [];
    } else { out[tag] = { error: "tuntematon tagi (dlXX, F1/T1/G_Air[.pv|.sp|.out|.out_heat|.out_cool], outdoor)" }; continue; }
    const where = `${base} AND ${tCol} >= ${r.fromSql} AND ${tCol} <= ${r.toSql} AND ${valCol} IS NOT NULL`;
    const p = [...params, ...r.params];
    if (agg === "minmax") {
      const [s] = await roQuery(`SELECT COUNT(*) n, MIN(${valCol}) min, MAX(${valCol}) max, ROUND(AVG(${valCol}),2) avg, ${toLocal(`MIN(${tCol})`)} first, ${toLocal(`MAX(${tCol})`)} last FROM ${where}`, p);
      const [mn] = await roQuery(`SELECT ${toLocal(tCol)} t FROM ${where} ORDER BY ${valCol} ASC, ${tCol} LIMIT 1`, p);
      const [mx] = await roQuery(`SELECT ${toLocal(tCol)} t FROM ${where} ORDER BY ${valCol} DESC, ${tCol} LIMIT 1`, p);
      out[tag] = { ...s, min_at: mn?.t, max_at: mx?.t };
    } else if (agg === "hourly") {
      out[tag] = await roQuery(`SELECT DATE_FORMAT(CONVERT_TZ(${tCol},'UTC','${TZ}'),'%Y-%m-%d %H:00') h, ROUND(MIN(${valCol}),2) min, ROUND(MAX(${valCol}),2) max, ROUND(AVG(${valCol}),2) avg FROM ${where} GROUP BY h ORDER BY h LIMIT 200`, p);
    } else {
      out[tag] = await roQuery(`SELECT ${toLocal(tCol)} t, ${valCol} v FROM ${where} ORDER BY ${tCol} DESC LIMIT 200`, p);
    }
  }
  return pack(out, "ajat Europe/Helsinki");
}
async function getAlarmHistory(a) {
  const r = range(a);
  const adv = a.include_advisor ? "" : "AND point_id<>'LLM_Advisor'";
  const pt = a.point_id ? "AND point_id=?" : "";
  const rows = await roQuery(`SELECT ${toLocal("at")} at, point_id, alarm, event, value, ${toLocal("acked_at")} acked_at, acked_by FROM alarm_events
    WHERE at >= ${r.fromSql} AND at <= ${r.toSql} ${adv} ${pt} AND event IN ('start','clear','ack','llm') ORDER BY at LIMIT 300`, [...r.params, ...(a.point_id ? [a.point_id] : [])]);
  return pack(rows, "event: start=hälytys alkoi, clear=poistui, ack=kuitattu; ajat Europe/Helsinki");
}
async function listTables() {
  return pack(await roQuery("SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name"));
}
async function describeTable(a) {
  if (!/^[A-Za-z0-9_]+$/.test(a.table || "")) throw new Error("virheellinen taulun nimi");
  return pack(await roQuery("SELECT column_name, column_type, column_comment FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position", [a.table]));
}
async function runSql(a) { return pack(await roQuery(guardSql(a.sql)), "rajattu max 500 riviä; DATETIME-sarakkeet UTC"); }

const fn = (name, description, properties, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const T = { type: "string", description: "Helsingin paikallisaika 'YYYY-MM-DD HH:MM'; oletus: from=24 h sitten, to=nyt" };
export const TOOLS = [
  fn("get_measurements", "Mittausdata aikaväliltä. minmax: min/max/avg + min/max-ajankohdat; hourly: tuntikoosteet; raw: viimeisimmät 200 pistettä.",
    { tags: { type: "array", items: { type: "string" }, description: "esim. ['dl24','dl09','G_Air.pv','F1.sp','outdoor']" }, from: T, to: T, aggregate: { type: "string", enum: ["minmax", "hourly", "raw"] } }, ["tags"]),
  fn("get_alarm_history", "Hälytyshistoria (alarm_events) aikaväliltä.", { from: T, to: T, point_id: { type: "string" }, include_advisor: { type: "boolean", description: "sisällytä LLM_Advisor-huomiot" } }),
  fn("list_tables", "Listaa tietokannan taulut ja rivimäärät.", {}),
  fn("describe_table", "Taulun sarakkeet.", { table: { type: "string" } }, ["table"]),
  fn("run_sql", "Vain luku -SQL (MariaDB 10.11) Myko-tietokantaan. Yksi SELECT/WITH/SHOW/DESCRIBE; max 500 riviä, 10 s aikaraja. DATETIME-sarakkeet ovat UTC: käytä CONVERT_TZ(col,'UTC','Europe/Helsinki'). datalogger_values on iso (~6M riviä): rajaa aina source_id='src-datalogger', variable_key ja timestamp.",
    { sql: { type: "string" } }, ["sql"]),
  // kunnossapito (maintenance KB, separate DB kunnossapito; times are Helsinki local)
  fn("kp_search", "Hae kunnossapitotietokannasta (viat/incidents, toimenpiteet/actions, tunnetut korjaukset/known_fixes) tekstillä, esim. 'T1', 'ErrBits', 'restart'.", { text: { type: "string" } }, ["text"]),
  fn("kp_show_incident", "Näytä yksi vika (incident) ja sen toimenpiteet.", { id: { type: "integer" } }, ["id"]),
  fn("kp_match", "Etsi tunnetut korjaukset oireille. Palauttaa korjaukset, esiehdot, vaiheet ja onko autonominen suoritus sallittu.", {
    system: { type: "string", description: "PLC_2 | Myko | koti" }, device: { type: "string", description: "T1 | G_Air | F1 | LVV ..." },
    conditions: { type: "array", items: { type: "string" }, description: "esim. ['PLC restart/download']" },
    symptoms: { type: "array", items: { type: "string" }, description: "esim. ['ERRORBITS','PID_LAHTO_JUMISSA','PID output frozen']" } }),
  fn("kp_list_fixes", "Listaa tunnetut korjaukset.", {}),
  fn("kp_recent_incidents", "Viimeisimmät viat (myös Mykon automaattisesti avaamat hälytyksistä) täydellä kontekstilla: context_open/context_close (PID-arvot, 30 min/6 h trendi min/max/slope, PLC-restart, yhteydet, viimeisin komento, ulkolämpö, muut aktiiviset hälytykset), signature, kesto, resolved_by (cleared/manual_action/auto_recovery).", {
    hours: { type: "integer", description: "oletus 72" }, device: { type: "string", description: "esim. T1, F1, G_Air tai piste-id" }, alarm: { type: "string", description: "esim. PID_VIKA" },
    status: { type: "string", enum: ["open", "resolved", "info", "closed"] }, limit: { type: "integer", description: "max 50" } }),
  fn("kp_candidates", "Korjausehdokkaat: käsin tehdyt toimenpiteet, joiden jälkeen hälytys poistui (ryhmitelty signaturen ja toimenpiteen mukaan). Ehdokas ei ole tunnettu korjaus; ylennys ja autonomia vaativat aina käyttäjän hyväksynnän.", {}),
  fn("kp_stats", "Tilastot: viat hälytystyypeittäin (määrä, kesto, miten ratkesi), signaturet, tunnettujen korjausten onnistumiset/epäonnistumiset.", {}),
  fn("kp_policy", "Autonomisten toimenpiteiden politiikka.", {}),
  fn("kp_log_incident", "KIRJAA uusi vika kunnossapitoon (ei tee toimenpiteitä).", { system: { type: "string" }, device: { type: "string" }, symptom: { type: "string" },
    conditions: { type: "array", items: { type: "string" } }, root_cause: { type: "string" }, resolution: { type: "string" }, status: { type: "string", enum: ["open", "resolved", "info", "closed"] },
    ts_start: { type: "string", description: "Helsingin aika 'YYYY-MM-DD HH:MM:SS', oletus nyt" } }, ["system", "symptom"]),
  fn("kp_log_action", "KIRJAA toimenpide (esim. käyttäjän kertoma) vikaan. Ei suorita mitään.", { incident_id: { type: "integer" }, action: { type: "string" }, result: { type: "string" },
    worked: { type: "boolean" }, approved_by: { type: "string" }, ts: { type: "string" } }, ["action"]),
  ...WRITE_TOOLS,
];
const kpPack = async (p) => pack(await p, "kunnossapito; ajat Europe/Helsinki");
const IMPL = { get_measurements: getMeasurements, get_alarm_history: getAlarmHistory, list_tables: listTables, describe_table: describeTable, run_sql: runSql,
  kp_search: (a) => kpPack(kpSearch(a.text)), kp_show_incident: (a) => kpPack(kpShowIncident(a.id)),
  kp_match: (a) => kpPack(kpMatch({ system: a.system, device: a.device, conditions: a.conditions ?? [], symptoms: a.symptoms ?? [] })),
  kp_list_fixes: () => kpPack(kpListFixes()),
  kp_recent_incidents: (a) => kpPack(kpRecentIncidents(a ?? {})), kp_candidates: () => kpPack(kpCandidates()), kp_stats: () => kpPack(kpStats()), kp_policy: () => kpPack(kpPolicy()),
  kp_log_incident: (a) => kpPack(kpLogIncident(a)),
  kp_log_action: (a) => kpPack(kpLogAction({ ...a, actor: "deepseek-telegram", known_fix_id: null })) };
export async function callTool(name, args, ctx = {}) {
  const t0 = Date.now();
  try {
    let res;
    if (isWriteTool(name)) res = await callWriteTool(name, args || {}, ctx);
    else {
      const f = IMPL[name]; if (!f) throw new Error(`tuntematon työkalu ${name}`);
      res = await f(args || {});
    }
    audit({ ...ctx, tool: name, args, ms: Date.now() - t0, bytes: res.length });
    return res;
  } catch (e) {
    audit({ ...ctx, tool: name, args, ms: Date.now() - t0, error: e.message.slice(0, 300) });
    return JSON.stringify({ error: e.message.slice(0, 300) });
  }
}
export { isWriteTool, describeWrite };

export const SCHEMA_HINT = `TIETOKANTA (MariaDB, myko_valvomo; kaikki DATETIME = UTC, esitä ajat Europe/Helsinki):
- datalogger_values(timestamp, source_id='src-datalogger', variable_key dlXX, numeric_value = skaalattu arvo) ~1 näyte/min. Muuttujat: datalogger_variables.
- pid_training_log(at, pid_key F1|T1|G_Air, sp, csp, pv, out_heat, out_cool, out_sum, state, mode, man_en, err_bits, outdoor_temp) ~1/min.
- weather_metno(fetched_at, forecast_time, air_temperature, relative_humidity, wind_speed) = ulkolämpö (met.no).
- fmi_weather_obs(obs_time UTC tunnin hetkiarvo, t2m °C, rh %, td kastepiste, cloud_okta 0-8, precip_1h mm, pressure hPa, ws/wg m/s, wd °) = FMI-havainnot 2010→ (Nurmijärvi Röykkä fmisid 101149; tuuli Helsinki-Vantaa 100968). Pitkä historia ML:ään (F1/T1 vs ulkolämpö).
- fmi_weather_forecast(fetched_at, forecast_time, t, rh, ws, wg, wd, cloud_pct, precip_1h, symbol) = FMI-ennusteet Rajamäelle, tallennus 3 h välein.
- space_weather_kp(time_tag, kp, kind observed|estimated|predicted) = NOAA planetaarinen Kp (3 h). space_weather_log(at, kp_now, kp_max_24h_fc, sw_speed km/s, sw_density, bz nT, bt, nur_dx_1h = Nurmijärven magnetometrin X-vaihteluväli 1 h nT, aurora_level 0-4) 30 min välein.
- alarm_events(at, point_id, alarm, bit, event start|clear|ack|control|llm, value, acked_at, acked_by); alarm_points(id, name, unit, bits_json). point_id LLM_Advisor = tekoälyneuvojan huomiot, ei oikeita hälytyksiä.
- pid_param_history, pid_output_limits, pid_ai_analysis, llm_findings, events (tapahtumat/kirjaukset), units/transfers/strains (jäljitettävyys), environment_readings, audit_log, assistant_log.
TAGIT: dl24 vesilämpö °C, dl25 vesitaso %, dl23 EC/ppm, dl26 pH, dl04 PF-1 %, dl31 Poistoilma DS4 °C, dl30 Katto DS3 °C, dl03 Keskiosa DS2 °C, dl09 G1 temp °C, dl21 G Temp AHT °C, dl22 G kosteus %RH, dl15 G1 kosteus %RH, dl00 T1 Temp °C, dl02 F1 Temp °C, dl20 T3 Temp °C, dl17 T3 Hum %RH, dl05 WaterTemp °C.
PID: F1 = kylmiö, T1 = terraario, G_Air = kasvamon ilma (tagit F1.pv, F1.sp, F1.out...). outdoor = ulkolämpö (weather_metno).`;
