// Myko -> PLC DB_Myko (see the Page model, section DB_Myko / UDT_MykoFeedback).
// Everything that writes is behind the flag MYKO_DB_ENABLED=1 AND an auto-detected DB_Myko node.
// Until then settings are only stored (myko_settings) and shown in the UI; nothing is written to the PLC.
//   - settings per point: Safe_Output, PV_FreezeS (+ Common.Wd_TimeoutS)  -> <Struct>/Safe_Output, Safe_OutputSet, Safe_Source=0, PV_FreezeS
//   - heartbeat: Common.Hb_Counter +1 every 1 s (fixed rate), one persistent OPC UA session, Write service only
//   - sensor 5 V reset: Common.Cmd_SensorPwrReset := TRUE pulse (PLC clears), lockout 5 min + max 3 / 24 h, logged
import { spawn, execFile } from "node:child_process";
import readline from "node:readline";

const PY = "/home/atte/opcua-bridge/venv/bin/python";
const SCRIPT = "/home/atte/opcua-bridge/myko_db.py";
export const FLAG = process.env.MYKO_DB_ENABLED === "1";
const DEFAULTS = {
  common: { wdTimeoutS: 10, pwrOffS: 8, pwrLockoutS: 300 },
  points: {
    F1: { struct: "F1_Temp_Kylmio", safeOutput: 5, freezeS: 30 },
    T1: { struct: "T1_Temp_Terrario", safeOutput: 5, freezeS: 30 },
    G_Air: { struct: "GA_Temp_Kasvamo", safeOutput: 30, freezeS: 30 },
  },
};
const LIM = { safeOutput: [0, 100], freezeS: [10, 600], wdTimeoutS: [5, 120], pwrOffS: [5, 10], pwrLockoutS: [300, 3600] };
const RESET_LOCK_S = 300, RESET_PER_DAY = 3;

export function registerMykoDb(app, { query, asyncRoute }) {
  let settings = structuredClone(DEFAULTS);
  const detect = { found: null, at: null, fields: [], error: null };
  const writer = { running: false, hb: 0, lastHbAt: null, lastError: null, lastSettingsWrite: null };
  let child = null, seq = 0; const pending = new Map();

  const load = async () => {
    const [r] = await query("SELECT v FROM myko_settings WHERE k = 'db_myko'");
    if (r) { const v = typeof r.v === "string" ? JSON.parse(r.v) : r.v; settings = { common: { ...DEFAULTS.common, ...v.common }, points: Object.fromEntries(Object.entries(DEFAULTS.points).map(([k, d]) => [k, { ...d, ...(v.points?.[k] ?? {}), struct: d.struct }])) }; }
  };
  const runDetect = () => new Promise((resolve) => execFile(PY, [SCRIPT, "--detect"], { timeout: 60_000 }, (err, out) => {
    try { const j = JSON.parse(String(out).trim().split("\n").pop()); Object.assign(detect, { found: j.found, fields: Object.keys(j.fields ?? {}), types: j.fields ?? {}, iface: j.iface ?? null, error: null }); }
    catch { Object.assign(detect, { found: null, error: (err?.message ?? "detect failed").slice(0, 200) }); }
    detect.at = new Date().toISOString(); resolve(detect);
  }));
  const send = (msg) => new Promise((resolve, reject) => {
    if (!child) return reject(new Error("DB_Myko-kirjoitin ei ole käynnissä"));
    const id = ++seq; pending.set(id, { resolve, t: setTimeout(() => { pending.delete(id); reject(new Error("DB_Myko timeout")); }, 10_000) });
    child.stdin.write(JSON.stringify({ id, ...msg }) + "\n");
  });
  const settingsWrites = () => {
    const w = { "Common/Wd_TimeoutS": settings.common.wdTimeoutS, "Common/Pwr_OffS": settings.common.pwrOffS, "Common/Pwr_LockoutS": settings.common.pwrLockoutS };
    for (const p of Object.values(settings.points)) Object.assign(w, { [`${p.struct}/Safe_Output`]: p.safeOutput, [`${p.struct}/Safe_OutputSet`]: true, [`${p.struct}/Safe_Source`]: 0, [`${p.struct}/PV_FreezeS`]: p.freezeS });
    // only fields that exist in the detected DB (DB may be built in stages)
    return Object.fromEntries(Object.entries(w).filter(([k]) => detect.fields.includes(k)));
  };
  const pushSettings = async () => { if (!writer.running) return null; const r = await send({ write: settingsWrites() }); writer.lastSettingsWrite = { at: new Date().toISOString(), results: r.results }; return r; };

  function startWriter() {
    if (child) return;
    child = spawn(PY, [SCRIPT, "--daemon"], { stdio: ["pipe", "pipe", "pipe"] });
    readline.createInterface({ input: child.stdout }).on("line", (l) => {
      let m; try { m = JSON.parse(l); } catch { return; }
      if (m.ready) { writer.running = true; writer.lastError = null; pushSettings().catch((e) => (writer.lastError = e.message)); }
      if (m.error) { writer.running = false; writer.lastError = m.error; }
      const p = m.id && pending.get(m.id); if (p) { clearTimeout(p.t); pending.delete(m.id); p.resolve(m); }
    });
    child.stderr.on("data", () => {});
    child.on("exit", () => { child = null; writer.running = false; setTimeout(() => FLAG && detect.found && startWriter(), 30_000).unref(); });
  }
  // heartbeat at a fixed 1 s rate (independent of the alarm checker)
  setInterval(() => {
    if (!writer.running || !detect.fields.includes("Common/Hb_Counter")) return;
    writer.hb = (writer.hb + 1) & 0xffff;
    send({ write: { "Common/Hb_Counter": writer.hb } }).then(() => (writer.lastHbAt = new Date().toISOString())).catch((e) => (writer.lastError = e.message));
  }, 1000).unref();
  setInterval(() => pushSettings().catch(() => {}), 60_000).unref(); // re-assert after PLC restarts / downloads

  load().catch(() => {}).then(() => FLAG && runDetect().then((d) => d.found && startWriter()));
  setInterval(() => FLAG && !detect.found && runDetect().then((d) => d.found && startWriter()), 15 * 60_000).unref();

  const logEvent = (point, text) => query("INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, NULL, 'control', UTC_TIMESTAMP(3), NULL, NULL)", [point, text.slice(0, 255)]).catch(() => {});
  const status = async () => {
    const resets = await query("SELECT CAST(id AS INT) id, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%sZ') at, by_user, source, result, detail FROM sensor_reset_log ORDER BY id DESC LIMIT 10");
    return { flag: FLAG, settings, limits: LIM, detect, writer: { ...writer, running: writer.running }, resets: resets.map((r) => ({ ...r, id: Number(r.id) })), resetRule: { lockoutS: RESET_LOCK_S, perDay: RESET_PER_DAY } };
  };

  app.get("/api/myko/settings", asyncRoute(async (_req, res) => res.json(await status())));
  app.put("/api/myko/settings", asyncRoute(async (req, res) => {
    const b = req.body ?? {}; const next = structuredClone(settings); const bad = [];
    const chk = (obj, k, v) => { const l = LIM[k]; const x = Number(v); if (!l || !Number.isFinite(x) || x < l[0] || x > l[1]) bad.push(`${k}=${v} (${l?.join("–")})`); else obj[k] = x; };
    for (const [k, v] of Object.entries(b.common ?? {})) chk(next.common, k, v);
    for (const [p, o] of Object.entries(b.points ?? {})) { if (!next.points[p]) { bad.push(`piste ${p}`); continue; } for (const [k, v] of Object.entries(o)) if (k !== "struct") chk(next.points[p], k, v); }
    if (bad.length) return res.status(400).json({ error: `Virheelliset arvot: ${bad.join(", ")}` });
    await query("INSERT INTO myko_settings (k, v, updated_by) VALUES ('db_myko', ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)", [JSON.stringify(next), String(b.user || "dashboard").slice(0, 40)]);
    const diff = [];
    for (const [k, v] of Object.entries(next.common)) if (settings.common[k] !== v) diff.push(`${k} ${settings.common[k]}→${v}`);
    for (const [p, o] of Object.entries(next.points)) for (const k of ["safeOutput", "freezeS"]) if (settings.points[p][k] !== o[k]) diff.push(`${p}.${k} ${settings.points[p][k]}→${o[k]}`);
    settings = next;
    if (diff.length) logEvent("GardenAir", `Myko-asetukset: ${diff.join(", ")}${writer.running ? "" : " (tallennettu, ei kirjoitettu PLC:lle)"}`);
    const w = await pushSettings().catch((e) => ({ error: e.message }));
    res.json({ ...(await status()), written: w });
  }));
  app.post("/api/myko/detect", asyncRoute(async (_req, res) => { await runDetect(); if (FLAG && detect.found) startWriter(); res.json(await status()); }));

  // Sensor 5 V reset (SensorBlock 1+2 share one 5 V output bit). Lockout + daily cap enforced here AND in the PLC.
  async function sensorReset({ by, source, reason }) {
    const log = (result, detail) => query("INSERT INTO sensor_reset_log (at, by_user, source, result, detail) VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?)", [by, source, result, String(detail ?? "").slice(0, 500)]);
    const [last] = await query("SELECT TIMESTAMPDIFF(SECOND, MAX(at), UTC_TIMESTAMP()) age, SUM(at > UTC_TIMESTAMP() - INTERVAL 24 HOUR) n FROM sensor_reset_log WHERE result = 'sent'");
    let err = null;
    if (!FLAG) err = "DB_Myko ei ole käytössä (MYKO_DB_ENABLED ei päällä)";
    else if (!detect.found || !detect.fields.includes("Common/Cmd_SensorPwrReset")) err = "DB_Myko.Common.Cmd_SensorPwrReset puuttuu PLC:stä";
    else if (last?.age !== null && last?.age !== undefined && Number(last.age) < RESET_LOCK_S) err = `lukitus: edellinen reset ${Number(last.age)} s sitten (väh. ${RESET_LOCK_S} s)`;
    else if (Number(last?.n ?? 0) >= RESET_PER_DAY) err = `enintään ${RESET_PER_DAY} resetiä / 24 h`;
    if (err) { await log("rejected", `${err}${reason ? ` · ${reason}` : ""}`); logEvent("GardenAir", `Anturireset hylätty (${by}): ${err}`); const e = new Error(err); e.code = 409; throw e; }
    const r = await send({ write: { "Common/Cmd_SensorPwrReset": true }, read: ["Status/Pwr_Rejected", "Status/Pwr_ResetCount"] });
    await log("sent", JSON.stringify(r.results)); logEvent("GardenAir", `Anturien 5 V reset lähetetty (${by})${reason ? `: ${reason}` : ""}`);
    return { ok: true, results: r.results };
  }
  app.post("/api/myko/sensor-reset", asyncRoute(async (req, res) => {
    try { res.json(await sensorReset({ by: String(req.body?.user || "dashboard").slice(0, 40), source: "ui", reason: req.body?.reason })); }
    catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  }));
  return { status, sensorReset };
}
