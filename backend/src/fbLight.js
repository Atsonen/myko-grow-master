// FB_Light – Kasvamo-valaistus: suora OPC UA backendistä (ei lighting-MQTT:ä).
// LUKU/KIRJOITUS: node-opcua browse-path ServerInterfaces/Controls/Garden_Light_DB
// Ei mount/reconnect-kirjoituksia. FB_LIGHT_OPC_CONNECT=1 tuotannossa.
import fs from "node:fs";
import { query } from "./db.js";
import { notifyAlert } from "./notifyAlert.js";
import { DEFAULT_OPC, LightOpcPoller } from "./fbLightOpcUa.js";

const SETTINGS_KEY = "fb_light";
const STATE_DIR = process.env.MYKO_STATE_DIR || "/home/atte/.config/myko";
const STATE_PATH = `${STATE_DIR}/fb_light_alarm_state.json`;

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
  offline: "Valaistus: OPC UA ei dataa",
};

const FORBIDDEN_WRITE = new Set(["Init", "HB_OK", "LocalHour", "ClockValid", "LightOn"]);

const DEFAULT_CFG = {
  opc_direct: true,
  poll_s: 5,
  groups: [{ id: "garden", label: "Garden_Light_DB", enabled: true }],
  opc: { ...DEFAULT_OPC, verified_at: "2026-11-07T16:09:00+02:00" },
  transport_note:
    "Suora OPC UA backendissä. Aseta FB_LIGHT_OPC_CONNECT=1 ja migrate fb_light myko_settings. Ei mqtt-riippuvuutta.",
};

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
  return {
    present: p.present === true,
    contract_error: p.contract_error === true,
    opc_quality: p._quality ?? p.opc_quality,
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
}

export function scheduleHint(localHour, onH, offH) {
  if (!Number.isFinite(localHour) || !Number.isInteger(onH) || !Number.isInteger(offH)) return { text: "—", inWindow: null };
  if (onH === offH) return { text: "Pois (On=Off)", inWindow: false };
  const h = ((localHour % 24) + 24) % 24;
  let inWindow;
  if (onH < offH) inWindow = h >= onH && h < offH;
  else inWindow = h >= onH || h < offH;
  const pad = (x) => String(x).padStart(2, "0");
  return { text: `${pad(onH)}:00–${pad(offH)}:00 (PLC)`, inWindow };
}

export function outputIndication(plc) {
  const cmd = plc.LightOn === true;
  const fb = plc.LightFb;
  if (fb === undefined) return { kind: "cmd", on: cmd, text: cmd ? "Käsky ON" : "Käsky OFF" };
  return { kind: "fb", on: fb === true, text: fb === true ? "Palaute ON" : "Palaute OFF", cmd };
}

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

const CONTRACT_BOOL = ["Init", "Enable", "ClockValid", "HB_OK", "LightOn", "ConfigOK", "ClockOK", "ScheduleActive", "Ready", "Armed"];
const CONTRACT_INT = ["Mode", "OnHour", "OffHour", "LocalHour"];

export function validateOpcSnapshot(raw) {
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

/** @deprecated use validateOpcSnapshot */
export const validateMqttContract = validateOpcSnapshot;

export function lightAlarmConditions(plc, ctx = {}) {
  const out = {};
  const fresh = plc.present && !ctx.stale && ctx.mappingOk !== false && !plc.contract_error
    && plc.opc_quality !== "Bad";
  if (!fresh) {
    out.offline = [false, TEXTS.offline];
    return out;
  }
  if (plc.Enable !== true) return out;
  const mode = plc.Mode;
  out.hb = [plc.HB_OK === false, TEXTS.hb];
  out.config = [plc.ConfigOK === false, TEXTS.config];
  out.clock = [mode === 1 && (plc.ClockOK === false || plc.ClockValid === false), TEXTS.clock];
  return out;
}

const lightId = (groupId, key) => {
  const s = `${groupId}:${key}`;
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return -(1_840_000_000 + (h % 9_000_000));
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
    opc: { ...DEFAULT_CFG.opc, ...(c.opc ?? {}) },
    groups: groups.map((g, i) => ({
      id: String(g.id ?? `g${i}`),
      label: String(g.label ?? g.id ?? `Ryhmä ${i + 1}`),
      enabled: g.enabled !== false,
    })),
  };
}

/** @type {Map<string, { plc: object, at: number }>} */
const live = new Map();
let st = {};
let moduleStartedAt = Date.now();
let evalTimer = null;
const poller = new LightOpcPoller();

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
  const r = await notifyAlert(t, { tag: "fblight ", tgSend: process.env.FB_LIGHT_NOTIFY_MOCK === "1" ? async () => false : undefined });
  if (!r.ok && process.env.FB_LIGHT_NOTIFY_MOCK !== "1") console.warn("[fblight] notify fail", r.error || r.channel);
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
        if (process.env.FB_LIGHT_NOTIFY_MOCK !== "1") await notifySafe(`🚨 ${msg} [${groupId}]`);
      }
    } else if (!bad) {
      delete gs.since[key];
      if (gs.active[key]) {
        gs.active[key] = false;
        console.log(`[fblight] clear ${groupId}/${key}`);
        if (process.env.FB_LIGHT_NOTIFY_MOCK !== "1") await notifySafe(`✅ Palautui: ${gs.msg[key] ?? msg} [${groupId}]`);
      }
    }
  }
  saveSt();
}

export function ingestLightSnapshot(groupId, payload) {
  const contract = validateOpcSnapshot(payload);
  if (!contract.ok) {
    console.warn(`[fblight] contract fail ${groupId}: ${contract.errors.join(",")}`);
    live.set(groupId, { plc: normalizePlcPayload({ contract_error: true, present: false }), at: Date.now() });
    return;
  }
  const plc = normalizePlcPayload({ ...payload, present: true });
  live.set(groupId, { plc, at: Date.now() });
  const opcStatus = poller.status();
  const commissioned = opcStatus.connect_enabled && opcStatus.resolved;
  const cond = lightAlarmConditions(plc, { stale: false, mappingOk: commissioned });
  void evalGroupAlarms(groupId, cond, { commissioned });
}

/** @deprecated */
export const ingestLightMqtt = ingestLightSnapshot;

export function startFbLight(_opts = {}) {
  void (async () => {
    const cfg = await loadCfg();
    poller.on("snapshot", (snap) => {
      const gid = cfg.groups.find((g) => g.enabled)?.id ?? "garden";
      if (snap.error) {
        live.set(gid, { plc: normalizePlcPayload({ present: false }), at: 0 });
        return;
      }
      ingestLightSnapshot(gid, snap.values);
    });
    await poller.start({ opc: cfg.opc, poll_s: cfg.poll_s ?? 5 });
  })();

  evalTimer = setInterval(() => {
    void (async () => {
      const cfg = await loadCfg();
      const now = Date.now();
      const opcSt = poller.status();
      const commissioned = opcSt.connect_enabled && opcSt.resolved;
      for (const g of cfg.groups) {
        if (!g.enabled) continue;
        const L = live.get(g.id);
        const stale = !L?.at || now - L.at > STALE_MS;
        const plc = L?.plc ?? normalizePlcPayload({ present: false });
        const cond = lightAlarmConditions(plc, { stale, mappingOk: commissioned });
        if (commissioned && stale) cond.offline = [true, TEXTS.offline];
        await evalGroupAlarms(g.id, cond, { commissioned });
      }
    })();
  }, 10_000);
}

export function stopFbLightForTests() {
  if (evalTimer) clearInterval(evalTimer);
  evalTimer = null;
  void poller.stop();
}

export function registerFbLightRoutes(app) {
  app.get("/api/light", async (_req, res) => {
    try {
      const cfg = await loadCfg();
      const now = Date.now();
      const opcSt = poller.status();
      const groups = cfg.groups.map((g) => {
        const L = live.get(g.id);
        const stale = !L?.at || now - L.at > STALE_MS;
        const plc = L?.plc ?? normalizePlcPayload({});
        const opc_ready = opcSt.connect_enabled && opcSt.resolved;
        const schedule = scheduleHint(plc.LocalHour, plc.OnHour, plc.OffHour);
        const out = outputIndication(plc);
        const gs = groupState(g.id);
        return {
          id: g.id,
          label: g.label,
          mapping_pending: !opc_ready,
          transport: "opcua-direct",
          opc_status: opcSt,
          plc,
          plc_at: L?.at ? new Date(L.at).toISOString() : null,
          stale: stale || !opc_ready,
          present: plc.present && !stale && opc_ready,
          write_allowed: opc_ready && !stale && plc.present,
          schedule,
          output: out,
          mode_label: MODE_FI[plc.Mode] ?? (plc.Mode == null ? "—" : String(plc.Mode)),
          alarms: { active: Object.fromEntries(Object.entries(gs.active).filter(([, v]) => v)), texts: TEXTS },
        };
      });
      const live_ready = groups.some((g) => g.present);
      res.json({
        groups,
        config: cfg,
        write_note: "Vain Enable, Mode (0–2), OnHour/OffHour OPC Input-kenttiin. Ei Init/HB/kelloa/outputeja.",
        allowed_writes: Object.keys(WRITE_ALLOWED),
        mapping_pending: !opcSt.resolved && opcSt.connect_enabled,
        commissioned: opcSt.resolved,
        live_ready,
        transport: "opcua-direct",
        opc: cfg.opc,
        opc_runtime: opcSt,
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
      const opcSt = poller.status();
      if (!opcSt.connect_enabled) return res.status(503).json({ error: "OPC ei käytössä (FB_LIGHT_OPC_CONNECT!=1)" });
      if (!opcSt.resolved) return res.status(503).json({ error: "OPC resolve/identity epäonnistui" });
      const L = live.get(g.id);
      const stale = !L?.at || Date.now() - L.at > STALE_MS;
      if (stale || !L?.plc?.present) return res.status(409).json({ error: "Data vanhentunut – kirjoitus estetty" });
      if (req.body?.confirm !== true) return res.status(400).json({ error: "vahvistus puuttuu (confirm: true)" });
      const v = validateLightWrite(req.body);
      if (v.error) return res.status(400).json({ error: v.error });
      const wr = await poller.write(v.ok);
      if (!wr.ok) return res.status(502).json({ error: wr.error ?? "kirjoitus epäonnistui" });
      res.json({ ok: true, readback: wr.readback, by: String(req.body?.by ?? "myko-ui") });
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
  validateOpcSnapshot,
  validateMqttContract: validateOpcSnapshot,
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
  poller,
};
