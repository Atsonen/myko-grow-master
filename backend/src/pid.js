// OPC UA PID faceplates + PID alarm points.
// opcua-bridge publishes Sensors/PLC_2/<key>_PID (flat JSON, ~1 s on change, 60 s heartbeat) and executes
// whitelisted commands from Myko/Cmd/<key>_PID (ack on .../ack). This module:
//  - caches the latest values + a cheap in-memory mini trend (30 s samples, 6 h) per PID,
//  - exposes GET /api/pid/:key and POST /api/pid/:key/cmd (Setpoint goes via the controls route),
//  - evaluates PID alarms and publishes them as a normal alarm point (retained Myko/Alarms/<key>_PID/json,
//    same payload shape as the checker) -> mqtt-logger stores status + start/clear events, the alarm list shows
//    them and alarm_points_check.py sends WhatsApp with the parent point's mute (alarms_disabled_until).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PID_POINTS = { F1: "ColdStorage1", T1: "Terrario1", G_Air: "GardenAir" }; // pid key -> parent measurement point
export const PID_BY_POINT = Object.fromEntries(Object.entries(PID_POINTS).map(([k, v]) => [v, k]));
const CMD_KEYS = ["Input", "Setpoint", "ManualEnable", "ManualValue", "Mode", "ModeActivate", "ErrorAck", "HeatEnableTuning", "CoolEnableTuning"];

// Alarm bits of the <key>_PID alarm points (ISA-18.2 style: few, actionable, debounced).
export const PID_ALARM_BITS = [
  { bit: 0, key: "EI_AUTO", level: "alarm", rule: "Säädin poistunut automaatilta (State≠3) yli 10 s ilman dashboard-komentoa (dashboardista käynnistetty viritys State 1/2 ei hälytä; epäonnistunut viritys → hälyttää)" },
  { bit: 1, key: "PID_VIKA", level: "alarm", rule: "PID Error=1 (vika päällä) yli 5 s" },
  { bit: 2, key: "ERRORBITS", level: "warn", rule: "ErrorBits≠0 yli 10 s (kuittaamaton vika, ErrorAck)" },
  { bit: 3, key: "OPCUA", level: "warn", rule: "Ei PID-dataa OPC UA:sta yli 60 s" },
  { bit: 4, key: "SATUROITUNUT", level: "warn", rule: "Lähtö ±100 % yli 30 min (vain loki, ei WhatsAppia)" },
  { bit: 5, key: "SENSOR_VIKA", level: "alarm", rule: "Myko PV-syöttö päällä: ei hyväksyttyä anturiarvoa 30 s (ESP-virhekoodi/epäuskottava/piikki) yli 10 s" },
  { bit: 7, key: "ANTURIVIKA_ALASAJO", level: "alarm", rule: "P1: anturivika/ei päivity yli alasajoajan (oletus 5 min) -> Myko asetti ON pois (lämmitys+jäähdytys seis). Ei automaattista uudelleenkäynnistystä." },
  { bit: 6, key: "INPUT_STALE", level: "alarm", rule: "Myko PV-syöttö päällä: Input-kirjoitus PLC:lle ei onnistunut yli 60 s" },
];
const DEB = { ANTURIVIKA_ALASAJO: 0, SENSOR_VIKA: 10, INPUT_STALE: 10, EI_AUTO: 10, PID_VIKA: 5, ERRORBITS: 10, SATUROITUNUT: 1800 }; // seconds
const STALE_S = 60;
const INTENT_S = 60; // a Mode/ManualEnable command within this window makes a State change "intended"

const DIR = path.dirname(fileURLToPath(import.meta.url));
const INTENT_FILE = path.join(DIR, "..", "pid-intent.json");

export function registerPidRoutes(app, { mqttClient, query, asyncRoute }) {
  const state = {}; // key -> { at, values }
  const trend = {}; // key -> [{t, pv, sp, out}]
  const acks = new Map();
  const cond = {}; // key -> { NAME: sinceMs }
  const active = {}; // key -> Set
  const sinceIso = {}; // key -> {NAME: iso}
  const lastPub = {};
  let intent = {};
  try { intent = JSON.parse(fs.readFileSync(INTENT_FILE, "utf8")); } catch { intent = {}; }
  const saveIntent = () => fs.writeFile(INTENT_FILE, JSON.stringify(intent), () => undefined);
  const started = Date.now();
  const hooks = {}; // feedAlarms(k) from pvfeed.js

  const c = mqttClient();
  const topics = Object.keys(PID_POINTS).flatMap((k) => [`Sensors/PLC_2/${k}_PID`, `Myko/Cmd/${k}_PID/ack`]);
  const sub = () => c.subscribe(topics, { qos: 0 });
  c.on("connect", sub);
  if (c.connected) sub();
  c.on("message", (topic, buf) => {
    let d;
    try { d = JSON.parse(buf.toString()); } catch { return; }
    const m = /^Sensors\/PLC_2\/(\w+)_PID$/.exec(topic);
    if (m && PID_POINTS[m[1]]) {
      const k = m[1];
      const prevState = state[k]?.values?.State;
      state[k] = { at: Date.now(), values: { ...(state[k]?.values ?? {}), ...d } };
      const st = state[k].values.State;
      const recent = intent[k]?.cmdAt && Date.now() - intent[k].cmdAt < INTENT_S * 1000;
      if (prevState === 3 && st !== 3 && st !== undefined) {
        intent[k] = { ...(intent[k] ?? {}), intended: Boolean(recent), tuning: Boolean(recent && intent[k]?.tuneCmd && (st === 1 || st === 2)), leftAt: Date.now() };
        saveIntent();
      } else if ((st === 1 || st === 2) && prevState !== undefined && prevState !== st && recent && intent[k]?.tuneCmd) {
        // tuning started from a non-auto state (e.g. manual/inactive) or pretuning -> fine tuning
        intent[k] = { ...(intent[k] ?? {}), intended: true, tuning: true, leftAt: Date.now() };
        saveIntent();
      } else if (st === 3 && (intent[k]?.intended || intent[k]?.tuning)) {
        intent[k] = { ...intent[k], intended: false, tuning: false };
        saveIntent();
      } else if (intent[k]?.tuning && st !== undefined && st !== 1 && st !== 2 && st !== 3 && !recent) {
        // tuning ended somewhere other than automatic (error -> inactive/substitute/manual): alarm again
        intent[k] = { ...intent[k], intended: false, tuning: false, tuneFailedAt: Date.now() };
        saveIntent();
      }
      return;
    }
    if (topic.endsWith("/ack") && d?.id && acks.has(d.id)) { acks.get(d.id)(d); acks.delete(d.id); }
  });

  // mini trend: one sample per 30 s while data is fresh
  setInterval(() => {
    for (const k of Object.keys(PID_POINTS)) {
      const s = state[k];
      if (!s || Date.now() - s.at > STALE_S * 1000) continue;
      const a = (trend[k] ??= []);
      a.push({ t: Date.now(), pv: s.values.PV, sp: s.values.SP, out: s.values.OutSum });
      if (a.length > 720) a.splice(0, a.length - 720);
    }
  }, 30_000).unref();

  async function pidCommand(key, cmd, by) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if ("Mode" in cmd || "ManualEnable" in cmd) { intent[key] = { ...(intent[key] ?? {}), cmdAt: Date.now(), tuneCmd: cmd.Mode === 1 || cmd.Mode === 2 }; saveIntent(); }
    const ackP = new Promise((resolve) => {
      acks.set(id, resolve);
      setTimeout(() => { if (acks.delete(id)) resolve(null); }, 6000);
    });
    await new Promise((res, rej) =>
      c.publish(`Myko/Cmd/${key}_PID`, JSON.stringify({ id, by, ...cmd }), { qos: 1, retain: false }, (e) => (e ? rej(e) : res())),
    );
    const ack = await ackP;
    if (!ack) return { id, error: "no ack from opcua-bridge (6 s)" };
    const failed = Object.entries(ack.results ?? {}).filter(([, v]) => typeof v === "string");
    return { id, results: ack.results, error: failed.length ? failed.map(([k, v]) => `${k}: ${v}`).join("; ") : undefined };
  }

  // ---- alarm evaluation (every 2 s; publish on change and every 60 s) ----
  function evaluate(k) {
    const now = Date.now();
    const s = state[k];
    const v = s?.values ?? {};
    const stale = !s || now - s.at > STALE_S * 1000;
    const cs = (cond[k] ??= {});
    const prevActive = active[k] ?? new Set();
    const act = new Set();
    const hold = (name, on) => {
      if (on) { cs[name] ??= now; if (now - cs[name] >= (DEB[name] ?? 0) * 1000) act.add(name); }
      else delete cs[name];
    };
    if (stale) {
      if (now - started > 90_000) act.add("OPCUA");
      for (const n of ["EI_AUTO", "PID_VIKA", "ERRORBITS", "SATUROITUNUT"]) if (prevActive.has(n)) act.add(n); // freeze while blind
    } else {
      hold("EI_AUTO", v.State !== undefined && v.State !== 3 && !intent[k]?.intended);
      hold("PID_VIKA", v.Err === true);
      hold("ERRORBITS", (v.ErrBits ?? 0) !== 0 && v.Err !== true);
      hold("SATUROITUNUT", v.State === 3 && Math.abs(v.OutSum ?? 0) >= 99.5);
    }
    const fa = hooks.feedAlarms?.(k) ?? {};
    hold("SENSOR_VIKA", fa.SENSOR_VIKA === true);
    hold("INPUT_STALE", fa.INPUT_STALE === true);
    hold("ANTURIVIKA_ALASAJO", fa.ANTURIVIKA_ALASAJO === true);
    const si = (sinceIso[k] ??= {});
    for (const n of act) if (!prevActive.has(n)) si[n] = new Date(cs[n] ?? now).toISOString();
    for (const n of Object.keys(si)) if (!act.has(n)) delete si[n];
    const changed = act.size !== prevActive.size || [...act].some((n) => !prevActive.has(n));
    active[k] = act;
    if (!changed && now - (lastPub[k] ?? 0) < 60_000) return;
    if (now - started < 15_000) return; // let the first PID messages arrive
    const bits = Object.fromEntries(PID_ALARM_BITS.map((b) => [b.key, b.bit]));
    const word = [...act].reduce((w, n) => w | (1 << bits[n]), 0);
    const payload = {
      status: word, alarm_bits: word, active: PID_ALARM_BITS.map((b) => b.key).filter((n) => act.has(n)), bits,
      temp: Number.isFinite(v.PV) ? v.PV : null,
      last_reading: s ? new Date(s.at).toISOString() : null,
      checked: new Date(now).toISOString(),
      since: { ...si },
      pid: { State: v.State, Mode: v.Mode, Err: v.Err, ErrBits: v.ErrBits, Warn: v.Warn, OutSum: v.OutSum, SP: v.SP, intended: Boolean(intent[k]?.intended), tuning: Boolean(intent[k]?.tuning) },
      source: "myko-backend pid.js",
    };
    lastPub[k] = now;
    c.publish(`Myko/Alarms/${k}_PID/json`, JSON.stringify(payload), { qos: 1, retain: true });
  }
  setInterval(() => { for (const k of Object.keys(PID_POINTS)) evaluate(k); }, 2000).unref();

  app.get(
    "/api/pid/:key",
    asyncRoute(async (req, res) => {
      const key = req.params.key;
      const pointId = PID_POINTS[key];
      if (!pointId) return res.status(404).json({ error: "Unknown PID" });
      const commands = await query(
        `SELECT alarm, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%sZ') AS at FROM alarm_events
         WHERE point_id = ? AND event = 'control' AND (alarm LIKE 'PID %' OR alarm LIKE 'SP %') ORDER BY at DESC, id DESC LIMIT 6`,
        [pointId],
      ).catch(() => []);
      res.json({
        key, pointId, alarmPointId: `${key}_PID`,
        at: state[key] ? new Date(state[key].at).toISOString() : null,
        values: state[key]?.values ?? null,
        active: [...(active[key] ?? [])],
        intended: Boolean(intent[key]?.intended),
        tuning: Boolean(intent[key]?.tuning),
        trend: req.query.trend === "1" ? trend[key] ?? [] : undefined,
        commands,
      });
    }),
  );
  // POST /api/pid/:key/cmd  {ManualEnable?:bool, ManualValue?:-100..100, Mode?:0|3|4 + ModeActivate:true, ErrorAck?:true}
  app.post(
    "/api/pid/:key/cmd",
    asyncRoute(async (req, res) => {
      const key = req.params.key;
      const pointId = PID_POINTS[key];
      if (!pointId) return res.status(404).json({ error: "Unknown PID" });
      const b = req.body ?? {};
      const bad = (m) => res.status(400).json({ error: m });
      const cmd = {};
      for (const [k, v] of Object.entries(b)) {
        if (!CMD_KEYS.includes(k) || k === "Setpoint" || k === "Input") return bad(`${k} not allowed here`);
        if (["ManualEnable", "ModeActivate", "ErrorAck", "HeatEnableTuning", "CoolEnableTuning"].includes(k) && typeof v !== "boolean") return bad(`${k} must be true/false`);
        if ((k === "ModeActivate" || k === "ErrorAck") && v !== true) return bad(`${k} is a pulse (true)`);
        if (k === "ManualValue" && !(typeof v === "number" && v >= -100 && v <= 100)) return bad("ManualValue must be -100..100 %");
        if (k === "Mode" && ![0, 1, 2, 3, 4].includes(v)) return bad("Mode must be 0..4");
        cmd[k] = v;
      }
      if ("Mode" in cmd !== "ModeActivate" in cmd) return bad("Mode and ModeActivate go together");
      if (!Object.keys(cmd).length) return bad("empty command");
      if (cmd.Mode === 1 || cmd.Mode === 2) {
        if (typeof cmd.HeatEnableTuning !== "boolean" || typeof cmd.CoolEnableTuning !== "boolean" || cmd.HeatEnableTuning === cmd.CoolEnableTuning)
          return bad("tuning needs exactly one of HeatEnableTuning / CoolEnableTuning = true");
      } else if ("HeatEnableTuning" in cmd || "CoolEnableTuning" in cmd) return bad("EnableTuning only together with Mode 1/2");
      const r = await pidCommand(key, cmd, "dashboard");
      const label = `PID ${Object.entries(cmd).map(([k, v]) => `${k}=${v}`).join(", ")}${r.error ? " (VIRHE)" : ""}`.slice(0, 80);
      await query(
        "INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, NULL, 'control', UTC_TIMESTAMP(3), NULL, NULL)",
        [pointId, label],
      ).catch((e) => console.error("[pid] event log", e.message));
      res.status(r.error ? 502 : 200).json(r);
    }),
  );
  // ---- Setpoint sync: Myko SP (alarm_point_controls) is authoritative for every PID ----
  // Monitored PIDs: every 15 s compare the PLC Setpoint (fresh bridge data only) with Myko's SP; if |Δ| > 0.05 rewrite
  // Myko's value (whitelisted Setpoint command) and log 'SP palautettu old→new'. Covers PLC restart/download and bridge
  // reconnect (state becomes fresh again -> next tick). Command-only PIDs (no monitored data, e.g. G_Air): rewrite every
  // 60 s blindly. Rate limit: >= 30 s between writes per PID. Never writes when Myko SP is unknown.
  const SYNC_TOL = 0.05, SYNC_MIN_GAP_S = 30, BLIND_EVERY_S = 60;
  const syncAt = {};
  const COMMAND_ONLY = new Set(["G_Air"]); // bridge monitor:false (PLC monitored-item limit)
  async function spSync() {
    const rows = await query("SELECT point_id, setpoint, setpoint_exact FROM alarm_point_controls").catch(() => []);
    const sp = new Map(rows.map((r) => [r.point_id, r.setpoint_exact ?? r.setpoint]));
    for (const [k, pointId] of Object.entries(PID_POINTS)) {
      const raw = sp.get(pointId);
      const want = raw === null || raw === undefined ? NaN : Math.round(Number(raw) * 10) / 10;
      if (!Number.isFinite(want)) continue;
      const now = Date.now();
      if (now - (syncAt[k] ?? 0) < SYNC_MIN_GAP_S * 1000) continue;
      const s = state[k], fresh = s && now - s.at <= STALE_S * 1000;
      const plc = fresh ? Number(s.values.SP) : NaN;
      let label;
      if (fresh && Number.isFinite(plc)) {
        if (Math.abs(plc - want) <= SYNC_TOL) continue;
        label = `SP palautettu ${plc}→${want} (PLC poikkesi Myko-arvosta)`;
      } else if (COMMAND_ONLY.has(k)) {
        if (now - (syncAt[k] ?? 0) < BLIND_EVERY_S * 1000) continue;
        label = syncAt[k] ? null : `SP synkronointi ${want} → PLC (ei OPC UA -seurantaa)`; // log first blind write only
      } else continue; // monitored PID but stale data: wait for the bridge
      syncAt[k] = now;
      const r = await pidCommand(k, { Setpoint: want }, "sp-sync").catch((e) => ({ error: e.message }));
      if (r.error) console.error(`[sp-sync] ${k} ${want}: ${r.error}`);
      else if (label) console.log(`[sp-sync] ${k} ${label}`);
      if (label || r.error)
        await query("INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, NULL, 'control', UTC_TIMESTAMP(3), ?, NULL)",
          [pointId, `${label ?? `SP ${want} → PLC`}${r.error ? " VIRHE" : ""}`.slice(0, 80), want]).catch(() => undefined);
    }
  }
  setTimeout(() => { spSync().catch(() => undefined); setInterval(() => spSync().catch((e) => console.error("[sp-sync]", e.message)), 15_000).unref(); }, 20_000).unref();

  // ---- ML training log: one row per PID per minute (fresh state only) + outdoor temperature from the datalogger ----
  // Outdoor tag: env OUTDOOR_TEMP_TAG (default dl05 "WaterTemp", diurnal profile -> outdoor probe; to be confirmed).
  const OUTDOOR_TAG = process.env.OUTDOOR_TEMP_TAG || "dl05";
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const bool = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
  async function trainingLog() {
    const now = Date.now();
    const [od] = await query(
      "SELECT numeric_value v FROM datalogger_values WHERE source_id = 'src-datalogger' AND variable_key = ? AND timestamp > UTC_TIMESTAMP() - INTERVAL 5 MINUTE AND numeric_value > -100 ORDER BY timestamp DESC LIMIT 1",
      [OUTDOOR_TAG]).catch(() => []);
    const outdoor = od ? num(od.v) : null;
    for (const k of Object.keys(PID_POINTS)) {
      const s = state[k];
      if (!s || now - s.at > STALE_S * 1000) continue;
      const v = s.values;
      await query(
        `INSERT IGNORE INTO pid_training_log (at, pid_key, sp, csp, pv, out_heat, out_cool, out_sum, state, mode, man_en, err_bits, outdoor_temp, outdoor_tag, pv_age_s)
         VALUES (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:00'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [k, num(v.SP), num(v.CSP), num(v.PV), num(v.OutHeat), num(v.OutCool), num(v.OutSum), num(v.State), num(v.Mode),
         bool(v.ManEn), num(v.ErrBits), outdoor, OUTDOOR_TAG, Math.round((now - s.at) / 1000)]).catch((e) => console.error("[pid-log]", e.message));
    }
  }
  setInterval(() => trainingLog().catch(() => undefined), 60_000).unref();

  return { pidCommand, pidState: (k) => state[k] ?? null, setFeedAlarms: (f) => { hooks.feedAlarms = f; } };
}
