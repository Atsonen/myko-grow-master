// Read-only DB tools for the Telegram DeepSeek assistant (function calling).
// Uses a dedicated MariaDB user (myko_ro: SELECT + SHOW VIEW only on myko_valvomo), credentials in
// /home/atte/.config/myko/db_ro.env (600, never logged). Extra guards: single statement, SELECT/WITH/SHOW/
// DESCRIBE/EXPLAIN only, forced row limit, max_statement_time, truncated output. Every call is audited to
// ~/.local/state/myko/tg_ai_queries.log (JSONL). Never touches the PLC.
import * as mariadb from "mariadb";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";

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
];
const IMPL = { get_measurements: getMeasurements, get_alarm_history: getAlarmHistory, list_tables: listTables, describe_table: describeTable, run_sql: runSql };
export async function callTool(name, args, ctx = {}) {
  const t0 = Date.now();
  try {
    const f = IMPL[name]; if (!f) throw new Error(`tuntematon työkalu ${name}`);
    const res = await f(args || {});
    audit({ ...ctx, tool: name, args, ms: Date.now() - t0, bytes: res.length });
    return res;
  } catch (e) {
    audit({ ...ctx, tool: name, args, ms: Date.now() - t0, error: e.message.slice(0, 300) });
    return JSON.stringify({ error: e.message.slice(0, 300) });
  }
}

export const SCHEMA_HINT = `TIETOKANTA (MariaDB, myko_valvomo; kaikki DATETIME = UTC, esitä ajat Europe/Helsinki):
- datalogger_values(timestamp, source_id='src-datalogger', variable_key dlXX, numeric_value = skaalattu arvo) ~1 näyte/min. Muuttujat: datalogger_variables.
- pid_training_log(at, pid_key F1|T1|G_Air, sp, csp, pv, out_heat, out_cool, out_sum, state, mode, man_en, err_bits, outdoor_temp) ~1/min.
- weather_metno(fetched_at, forecast_time, air_temperature, relative_humidity, wind_speed) = ulkolämpö (met.no).
- alarm_events(at, point_id, alarm, bit, event start|clear|ack|control|llm, value, acked_at, acked_by); alarm_points(id, name, unit, bits_json). point_id LLM_Advisor = tekoälyneuvojan huomiot, ei oikeita hälytyksiä.
- pid_param_history, pid_output_limits, pid_ai_analysis, llm_findings, events (tapahtumat/kirjaukset), units/transfers/strains (jäljitettävyys), environment_readings, audit_log, assistant_log.
TAGIT: dl24 vesilämpö °C, dl25 vesitaso %, dl23 EC/ppm, dl26 pH, dl04 PF-1 %, dl31 Poistoilma DS4 °C, dl30 Katto DS3 °C, dl03 Keskiosa DS2 °C, dl09 G1 temp °C, dl21 G Temp AHT °C, dl22 G kosteus %RH, dl15 G1 kosteus %RH, dl00 T1 Temp °C, dl02 F1 Temp °C, dl20 T3 Temp °C, dl17 T3 Hum %RH, dl05 WaterTemp °C.
PID: F1 = kylmiö, T1 = terraario, G_Air = kasvamon ilma (tagit F1.pv, F1.sp, F1.out...). outdoor = ulkolämpö (weather_metno).`;
