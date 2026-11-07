// FB_Light – Kasvamo-valaistus (CPU1215C).
// LIVE-integraatio ESTETTY kunnes TIA/OPC UA -julkaisu + vahvistettu mqtt_sensor/mqtt_cmd (ei arvattuja nodeja).
// LAN 2026-11-07: Controls/Sensors browsessa ei valaistus-/FB_Light-kenttiä; bridge-configissa ei lighting-mappingia.
// LUKU: bridge → Sensors/… (ryhmäkohtainen topic myko_settings fb_light.groups[].mqtt_sensor)
// KIRJOITUS: Myko/Cmd/… (groups[].mqtt_cmd) – vain Enable, Mode, OnHour, OffHour (vahvistus UI:sta).
// EI: Init, HB_OK, LocalHour, ClockValid, automaattinen uudelleenaseutus tai mount/reconnect-kirjoituksia.
//
// Hälytykset: hb, config, clock – sama notifyAlert-pipeline kuin FillPump; ei hälytystä normaalista
// pois/ajan ulkopuolella tai tavanomaisesta Mode0-kuittauksesta.
import fs from "node:fs";
import mqtt from "mqtt";
import { query } from "./db.js";
import { notifyAlert } from "./notifyAlert.js";

const SETTINGS_KEY = "fb_light";
const STATE_DIR = process.env.MYKO_STATE_DIR || "/home/atte/.config/myko";
const STATE_PATH = `${STATE_DIR}/fb_light_alarm_state.json`;

/** @typedef {{ id: string, label: string, mqtt_sensor: string|null, mqtt_cmd: string|null, enabled?: boolean }} LightGroupCfg */

export const MODE_FI = { 0: "Poissa", 1: "Auto", 2: "Käsi päälle" };
export const HB_DELAY_MS = 45_000;
export const ERR_DELAY_MS = 10_000;
export const STALE_MS = 30_000;
export const STARTUP_GRACE_MS = 60_000;

export const WRITE_ALLOWED = {
  Enable: { type: "bool" },
  Mode: { type: "int", min: 0, max: 2, allowed: [0, 1, 2] },
  OnHour: { type: "int", min: 0, max: 23 },
  OffHour: { type: "int", min: 0, max: 23 },
};

export const TEXTS = {
  hb: "Valaistus: turva-heartbeat (HB_OK) puuttuu",
  config: "Valaistus: konfiguraatiovirhe (ConfigOK=false)",
  clock: "Valaistus: PLC-kello ei kelpaa (ClockOK/ ClockValid)",
  offline: "Valaistus: ei dataa (MQTT/bridge)",
};

const FORBIDDEN_WRITE = new Set(["Init", "HB_OK", "LocalHour", "ClockValid", "LightOn"]);

/** Normalize one MQTT payload field set to canonical names. */
export function normalizePlcPayload(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const b = (k, ...alts) => {
    if (p[k] !== undefined) return p[k];
    for (const a of alts) if (p[a] !== undefined) return p[a];
    return undefined;
  };
  const n = (k, ...alts) => {
    const v = b(k, ...alts);
    return v === undefined || v === null ? undefined : Number(v);
  };
  const base = {
    present: p.present !== false && Object.keys(p).length > 0,
    contract_error: p.contract_error === true,
    Init: b("Init"),
    Enable: b("Enable"),
    HB_OK: b("HB_OK", "HbOk", "St_HbOk"),
    Mode: n("Mode"),
    OnHour: n("OnHour"),
    OffHour: n("OffHour"),
    LocalHour: n("LocalHour"),
    ClockValid: b("ClockValid"),
    LightOn: b("LightOn"),
    LightFb: b("LightFb", "PhysicalOn", "FeedbackOn"),
    ConfigOK: b("ConfigOK", "Cfg_OK"),
    ClockOK: b("ClockOK"),
    ScheduleActive: b("ScheduleActive"),
    Ready: b("Ready"),
    Armed: b("Armed"),
    at: p.at,
  };
  return base;
}

/** User-facing schedule hint (PLC runs real schedule; this is display-only). */
export function scheduleHint(localHour, onH, offH) {
  if (!Number.isFinite(localHour) || !Number.isInteger(onH) || !Number.isInteger(offH)) return { text: "—", inWindow: null };
  if (onH === offH) return { text: "Pois (On=Off)", inWindow: false };
  const h = ((localHour % 24) + 24) % 24;
  let inWindow;
  if (onH < offH) inWindow = h >= onH && h < offH;
  else inWindow = h >= onH || h < offH;
  const pad = (x) => String(x).padStart(2, "0");
  return {
    text: `${pad(onH)}:00–${pad(offH)}:00 (PLC)`,
    inWindow,
  };
}

export function outputIndication(plc) {
  const cmd = plc.LightOn === true;
  const fb = plc.LightFb;
  if (fb === undefined) return { kind: "cmd", on: cmd, text: cmd ? "Käsky ON" : "Käsky OFF" };
  return { kind: "fb", on: fb === true, text: fb === true ? "Palaute ON" : "Palaute OFF", cmd };
}

/**
 * Validate POST body for PLC writes.
 * @param {unknown} body
 */
export function validateLightWrite(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_json" };
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (["confirm", "by", "groupId"].includes(k)) continue;
    if (FORBIDDEN_WRITE.has(k)) return { error: `kielletty: ${k}` };
    const a = WRITE_ALLOWED[k];
    if (!a) return { error: `ei sallittu: ${k}` };
    if (a.type === "bool") {
      if (typeof v !== "boolean") return { error: `${k}: bool` };
      out[k] = v;
    } else if (a.type === "int") {
      const n = Number(v);
      if (!Number.isInteger(n)) return { error: `${k}: kokonaisluku` };
      if (a.allowed && !a.allowed.includes(n)) return { error: `${k}: sallitut ${a.allowed.join(",")}` };
      if (n < a.min || n > a.max) return { error: `${k}: ${a.min}–${a.max}` };
      out[k] = n;
    }
  }
  if (!Object.keys(out).length) return { error: "ei kirjoitettavia kenttiä" };
  return { ok: out };
}

/**
 * Alarm conditions for one normalized PLC snapshot (pure, for tests).
 * @param {ReturnType<typeof normalizePlcPayload>} plc
 * @param {{ stale?: boolean, mappingOk?: boolean }} ctx
 */
const CONTRACT_BOOL = ["Init", "Enable", "ClockValid", "HB_OK", "LightOn", "ConfigOK", "ClockOK", "ScheduleActive", "Ready", "Armed"];
const CONTRACT_INT = ["Mode", "OnHour", "OffHour", "LocalHour"];

/** Fail closed on type mismatch (verified Garden_Light_DB contract). */
export function validateMqttContract(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["invalid_json"] };
  const errors = [];
  for (const k of CONTRACT_BOOL) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "boolean") errors.push(`${k}:boolean`);
  }
  for (const k of CONTRACT_INT) {
    if (raw[k] === undefined) continue;
    const n = Number(raw[k]);
    if (!Number.isInteger(n) || typeof raw[k] === "boolean") errors.push(`${k}:int16`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function lightAlarmConditions(plc, ctx = {}) {
  const out = {};
  const fresh = plc.present && !ctx.stale && ctx.mappingOk !== false && !plc.contract_error;
  if (!fresh) {
    out.offline = [false, TEXTS.offline];
    return out;
  }
  // Normaali pois käytöstä (Enable=false) ei hälytä hb/config/clock – odotettu tila commissioningissa.
  if (plc.Enable !== true) return out;
  const mode = plc.Mode;
  out.hb = [plc.HB_OK === false, TEXTS.hb];
  out.config = [plc.ConfigOK === false, TEXTS.config];
  const needsClock = mode === 1;
  const clockBad = plc.ClockOK === false || plc.ClockValid === false;
  out.clock = [needsClock && clockBad, TEXTS.clock];
  return out;
}

const lightId = (groupId, key) => {
  const s = `${groupId}:${key}`;
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return -(1_840_000_000 + (h % 9_000_000));
};

const DEFAULT_CFG = {
  groups: [
    {
      id: "garden",
      label: "Garden_Light_DB",
      mqtt_sensor: null,
      mqtt_cmd: null,
      enabled: true,
    },
  ],
  opc: {
    endpoint: "opc.tcp://192.168.1.103:4840",
    interface_uri: "http://Controls",
    db_browse_name: "Garden_Light_DB",
    browse_path: "ServerInterfaces/Controls/Garden_Light_DB",
    verified_at: "2026-11-07T16:09:00+02:00",
    id_drift_note: "ns=5;i=1456 was Garden Temperature_Night — resolve by browse path, not numeric id alone",
  },
  bridge_note:
    "OPC UA julkaistu. mqtt_sensor/mqtt_cmd täytetään vasta kun /home/atte/opcua-bridge on päivitetty (katso garden_light.verified-snippet.yaml).",
  commissioning: {
    live_ready: false,
    opc_published: true,
    mqtt_observed: false,
    proposed_mqtt_sensor: "Sensors/PLC_2/Garden_Light",
    proposed_mqtt_cmd: "Myko/Cmd/Garden_Light",
    bridge_snippet: "deploy/opcua-bridge/garden_light.verified-snippet.yaml",
    settings_proposed: "deploy/myko_settings/fb_light.proposed.json",
    discovery_summary:
      "Garden_Light_DB löytyi Controls-browsesta. MQTT-passiivisessa tarkistuksessa ei vielä Garden_Light-aihetta. Repo bridge.py: topics-luku OK snippetillä; Cmd vaatii bridge-laajennuksen (kuten FertDose tuotannossa). End-to-end EI valmis.",
  },
};

async function loadCfg() {
  let r = null;
  try {
    [r] = await query(`SELECT v FROM myko_settings WHERE k = ?`, [SETTINGS_KEY]);
  } catch (e) {
    console.warn("[fblight] settings", e.message);
  }
  let c = {};
  try {
    c = r ? (typeof r.v === "string" ? JSON.parse(r.v) : (r.v ?? {})) : {};
  } catch { /* default */ }
  const groups = Array.isArray(c.groups) ? c.groups : DEFAULT_CFG.groups;
  return {
    ...DEFAULT_CFG,
    ...c,
    groups: groups.map((g, i) => ({
      id: String(g.id ?? `g${i}`),
      label: String(g.label ?? g.id ?? `Ryhmä ${i + 1}`),
      mqtt_sensor: g.mqtt_sensor != null ? String(g.mqtt_sensor) : null,
      mqtt_cmd: g.mqtt_cmd != null ? String(g.mqtt_cmd) : null,
      enabled: g.enabled !== false,
    })),
  };
}

/** @type {Map<string, { plc: object, at: number }>} */
const live = new Map();
/** @type {Record<string, { active: Record<string, boolean>, since: Record<string, number>, at: Record<string, number>, msg: Record<string, string>, acked: Record<string, {at:string,by:string}> }>} */
let st = {};
let MQ = null;
/** @type {Map<string, (j:unknown)=>void>} */
const PENDING = new Map();
let moduleStartedAt = Date.now();
let evalTimer = null;

try {
  const j = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  st = typeof j === "object" && j ? j : {};
} catch { /* first run */ }

const saveSt = () => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(st));
    fs.renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
  } catch (e) { console.warn("[fblight] state", e.message); }
};

function groupState(id) {
  if (!st[id]) st[id] = { active: {}, since: {}, at: {}, msg: {}, acked: {} };
  return st[id];
}

async function notifySafe(t) {
  const r = await notifyAlert(t, { tag: "fblight " });
  if (!r.ok) console.warn("[fblight] notify fail", r.error || r.channel);
}

async function evalGroupAlarms(groupId, cond, opts = {}) {
  if (opts.commissioned === false) return;
  const gs = groupState(groupId);
  const now = Date.now();
  if (now - moduleStartedAt < STARTUP_GRACE_MS) return;
  for (const [key, [bad, msg]] of Object.entries(cond)) {
    const delay = key === "hb" ? HB_DELAY_MS : ERR_DELAY_MS;
    if (bad && !gs.active[key]) {
      gs.since[key] ??= now;
      if (now - gs.since[key] >= delay) {
        gs.active[key] = true;
        gs.msg[key] = msg;
        gs.at[key] = now;
        delete gs.acked?.[key];
        console.log(`[fblight] ALARM ${groupId}/${key}: ${msg}`);
        await notifySafe(`🚨 ${msg} [${groupId}]`);
      }
    } else if (!bad) {
      delete gs.since[key];
      if (gs.active[key]) {
        gs.active[key] = false;
        console.log(`[fblight] clear ${groupId}/${key}`);
        await notifySafe(`✅ Palautui: ${gs.msg[key] ?? msg} [${groupId}]`);
      }
    }
  }
  saveSt();
}

let subscribedAck = new Set();

export function ingestLightMqtt(groupId, payload) {
  const contract = validateMqttContract(payload);
  if (!contract.ok) {
    console.warn(`[fblight] contract fail ${groupId}: ${contract.errors.join(",")}`);
    live.set(groupId, { plc: normalizePlcPayload({ contract_error: true, present: false }), at: Date.now() });
    return;
  }
  const plc = normalizePlcPayload({ ...payload, present: true });
  live.set(groupId, { plc, at: Date.now() });
  const mappingOk = true;
  const stale = false;
  const cond = lightAlarmConditions(plc, { stale, mappingOk });
  void evalGroupAlarms(groupId, cond, { commissioned: true });
}

export function startFbLight({ mqttUrl }) {
  const mq = mqtt.connect(mqttUrl, { clientId: `myko-backend-fblight-${process.pid}`, reconnectPeriod: 5000 });
  MQ = mq;

  const refreshSubs = async () => {
    const cfg = await loadCfg();
    const topics = cfg.groups.filter((g) => g.enabled && g.mqtt_sensor).map((g) => g.mqtt_sensor);
    for (const t of topics) if (MQ?.connected) MQ.subscribe(t, { qos: 0 });
    for (const g of cfg.groups) {
      if (g.mqtt_cmd && !subscribedAck.has(g.mqtt_cmd)) {
        subscribedAck.add(g.mqtt_cmd);
        if (MQ?.connected) MQ.subscribe(`${g.mqtt_cmd}/ack`, { qos: 0 });
      }
    }
  };

  mq.on("connect", () => { void refreshSubs(); });
  mq.on("message", (topic, buf) => {
    void (async () => {
      try {
        const cfg = await loadCfg();
        const j = JSON.parse(buf.toString());
        if (topic.endsWith("/ack")) {
          if (j?.id && PENDING.has(j.id)) { PENDING.get(j.id)(j); PENDING.delete(j.id); }
          return;
        }
        const g = cfg.groups.find((x) => x.mqtt_sensor === topic);
        if (g) ingestLightMqtt(g.id, j);
      } catch { /* ignore */ }
    })();
  });
  mq.on("error", () => undefined);

  evalTimer = setInterval(() => {
    void (async () => {
      const cfg = await loadCfg();
      const now = Date.now();
      for (const g of cfg.groups) {
        const commissioned = Boolean(g.mqtt_sensor && g.mqtt_cmd);
        if (!commissioned) continue;
        const L = live.get(g.id);
        const stale = !L?.at || now - L.at > STALE_MS;
        const plc = L?.plc ?? normalizePlcPayload({ present: false });
        const cond = lightAlarmConditions(plc, { stale, mappingOk: true });
        if (stale) cond.offline = [true, TEXTS.offline];
        await evalGroupAlarms(g.id, cond, { commissioned: true });
      }
    })();
  }, 10_000);
}

export function stopFbLightForTests() {
  if (evalTimer) clearInterval(evalTimer);
  evalTimer = null;
}

export function registerFbLightRoutes(app) {
  app.get("/api/light", async (_req, res) => {
    try {
      const cfg = await loadCfg();
      const now = Date.now();
      const groups = cfg.groups.map((g) => {
        const L = live.get(g.id);
        const stale = !L?.at || now - L.at > STALE_MS;
        const plc = L?.plc ?? normalizePlcPayload({});
        const mapping_pending = !g.mqtt_sensor || !g.mqtt_cmd;
        const schedule = scheduleHint(plc.LocalHour, plc.OnHour, plc.OffHour);
        const out = outputIndication(plc);
        const gs = groupState(g.id);
        return {
          id: g.id,
          label: g.label,
          mapping_pending,
          mqtt_sensor: g.mqtt_sensor,
          mqtt_cmd: g.mqtt_cmd,
          plc,
          plc_at: L?.at ? new Date(L.at).toISOString() : null,
          stale: stale || mapping_pending,
          present: plc.present && !stale && !mapping_pending,
          write_allowed: !mapping_pending,
          schedule,
          output: out,
          mode_label: MODE_FI[plc.Mode] ?? (plc.Mode == null ? "—" : String(plc.Mode)),
          alarms: {
            active: Object.fromEntries(Object.entries(gs.active).filter(([, v]) => v)),
            texts: TEXTS,
          },
        };
      });
      const commissioned = groups.some((g) => !g.mapping_pending);
      res.json({
        groups,
        config: cfg,
        write_note: commissioned
          ? "Vain Enable, Mode (0–2), OnHour/OffHour. Ei Init/HB/kelloa. Aikataulu PLC:n LocalHour:lla."
          : "Kirjoitus ja LIVE-valaistus estetty: OPC UA/MQTT-kartoitus puuttuu (commissioning).",
        allowed_writes: Object.keys(WRITE_ALLOWED),
        mapping_pending: groups.some((g) => g.mapping_pending),
        commissioned,
        live_ready: commissioned && groups.some((g) => g.present),
        commissioning: cfg.commissioning ?? DEFAULT_CFG.commissioning,
        opc: cfg.opc ?? DEFAULT_CFG.opc,
        bridge_note: cfg.bridge_note ?? DEFAULT_CFG.bridge_note,
        stale_ms: STALE_MS,
        startup_grace_s: STARTUP_GRACE_MS / 1000,
      });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });

  app.post("/api/light/:groupId", async (req, res) => {
    try {
      const cfg = await loadCfg();
      const g = cfg.groups.find((x) => x.id === req.params.groupId);
      if (!g) return res.status(404).json({ error: "tuntematon ryhmä" });
      if (!g.mqtt_cmd || !g.mqtt_sensor) return res.status(503).json({ error: "MQTT-kartoitus puuttuu (mapping_pending)" });
      const L = live.get(g.id);
      const stale = !L?.at || Date.now() - L.at > STALE_MS;
      if (stale) return res.status(409).json({ error: "Data vanhentunut – kirjoitus estetty" });
      if (req.body?.confirm !== true) return res.status(400).json({ error: "vahvistus puuttuu (confirm: true)" });
      const v = validateLightWrite(req.body);
      if (v.error) return res.status(400).json({ error: v.error });
      if (!MQ?.connected) return res.status(503).json({ error: "MQTT ei yhteyttä" });
      const id = `lt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const ack = await new Promise((resolve) => {
        const to = setTimeout(() => { PENDING.delete(id); resolve(null); }, 6000);
        PENDING.set(id, (j) => { clearTimeout(to); resolve(j); });
        MQ.publish(g.mqtt_cmd, JSON.stringify({ id, by: String(req.body?.by ?? "myko-ui"), ...v.ok }), { qos: 1 });
      });
      if (!ack) return res.status(504).json({ error: `Ei kuittausta (${g.mqtt_cmd}/ack)` });
      const results = ack.results || {};
      const bad = Object.entries(results).find(([, r]) => !r || r.result === undefined || !String(r.result).startsWith("ok"));
      if (bad) return res.status(502).json({ error: String(bad[1] ?? "tuntematon"), ack });
      res.json({ ok: true, results, by: String(req.body?.by ?? "myko-ui") });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });
}

export function fbLightAlarmRows() {
  const rows = [];
  for (const [groupId, gs] of Object.entries(st)) {
    for (const [k, active] of Object.entries(gs.active ?? {})) {
      if (!active) continue;
      rows.push({
        id: lightId(groupId, k),
        pointId: `Kasvamo_Light_${groupId}`,
        pointName: `Kasvamo · Valaistus · ${groupId}`,
        unit: "",
        alarm: `LIGHT_${groupId}_${k}`.toUpperCase(),
        bit: null,
        priority: k === "hb" ? 1 : 2,
        start: new Date(gs.at?.[k] ?? Date.now()).toISOString(),
        end: null,
        active: true,
        value: null,
        endValue: null,
        source: "Kasvamo",
        desc: String(gs.msg[k] ?? TEXTS[k] ?? k),
        acked: Boolean(gs.acked?.[k]),
        ackedAt: gs.acked?.[k]?.at ?? null,
        ackedBy: gs.acked?.[k]?.by ?? null,
        ackRequired: true,
      });
    }
  }
  return rows;
}

export function fbLightAck(ids, by) {
  let n = 0;
  for (const [groupId, gs] of Object.entries(st)) {
    gs.acked ??= {};
    for (const [k, active] of Object.entries(gs.active ?? {})) {
      if (!active || gs.acked[k]) continue;
      const id = lightId(groupId, k);
      if (ids.includes(id)) {
        gs.acked[k] = { at: new Date().toISOString(), by: String(by ?? "dashboard").slice(0, 80) };
        n++;
      }
    }
  }
  if (n) saveSt();
  return n;
}

export const __test = {
  lightAlarmConditions,
  validateLightWrite,
  validateMqttContract,
  scheduleHint,
  normalizePlcPayload,
  outputIndication,
  lightId,
  resetState: () => { st = {}; live.clear(); },
  forceAlarm: (groupId, key, msg = TEXTS[key] ?? key) => {
    const gs = groupState(groupId);
    gs.active[key] = true;
    gs.msg[key] = msg;
    gs.at[key] = Date.now();
    saveSt();
  },
  advancePastGrace: () => { moduleStartedAt = Date.now() - STARTUP_GRACE_MS - 5_000; },
};
