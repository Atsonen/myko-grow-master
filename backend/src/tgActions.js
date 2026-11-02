// Telegram write tools (LLM function calling): whitelist of Myko backend write APIs / OPC UA paths.
// Allowed ONLY when ctx.allowWrites === true (Atte's configured Telegram chat). Never SensorBlock / ESP.
// dry_run=true: plan + current PLC readback, no write. Every real write is audited to tg_writes.log + kunnossapito.
import { appendFileSync, mkdirSync } from "node:fs";
import { kpLogAction, kpLogIncident, kpOpenIncidentFor } from "./kunnossapito.js";
import { PID_POINTS } from "./pid.js";
import { query } from "./db.js";

const API_BASE = process.env.MYKO_API || "http://127.0.0.1:3010";
const AUDIT_DIR = "/home/atte/.local/state/myko";
const WRITE_LOG = `${AUDIT_DIR}/tg_writes.log`;
const PID_KEYS = Object.keys(PID_POINTS); // F1, T1, G_Air
const POINT_BY_KEY = PID_POINTS; // F1 -> ColdStorage1
const KEY_BY_POINT = Object.fromEntries(Object.entries(PID_POINTS).map(([k, v]) => [v, k]));

const fn = (name, description, properties, required = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

export const WRITE_TOOL_NAMES = new Set([
  "pid_cmd", "set_controls", "ack_alarms", "get_pid", "log_observation",
]);

export const WRITE_TOOLS = [
  fn("get_pid", "Lue PID-tilanne PLC:ltä (PV, SP, Mode, State, ErrBits, OutSum…). Käytä ennen/jälkeen toimenpidettä.",
    { key: { type: "string", enum: PID_KEYS } }, ["key"]),
  fn("pid_cmd", "Suorita PID-komento Myko-backendin kautta (POST /api/pid/:key/cmd → OPC UA). Whitelist: ErrorAck, Mode+ModeActivate (0/3/4), ManualEnable(+ManualValue). dry_run=true = ei kirjoitusta.",
    {
      key: { type: "string", enum: PID_KEYS },
      ErrorAck: { type: "boolean", description: "true = pulse ErrorAck" },
      Mode: { type: "integer", description: "0=off, 3=auto, 4=manual mode select; yhdessä ModeActivate" },
      ModeActivate: { type: "boolean", description: "true yhdessä Mode kanssa" },
      ManualEnable: { type: "boolean" },
      ManualValue: { type: "number", description: "-100..100 %, vain ManualEnable kanssa" },
      dry_run: { type: "boolean", description: "jos true, ei kirjoiteta PLC:lle" },
      reason: { type: "string", description: "lyhyt syy lokiin / kunnossapitoon" },
    }, ["key"]),
  fn("set_controls", "Aseta Myko-ohjaukset (PUT /api/alarms/:pointId/controls): on/heat/cool/setpoint/disableMinutes. point_id ColdStorage1|Terrario1|GardenAir tai key F1|T1|G_Air. dry_run=true = ei kirjoitusta.",
    {
      key: { type: "string", enum: PID_KEYS },
      point_id: { type: "string", enum: Object.values(PID_POINTS) },
      on: { type: "boolean" },
      heat: { type: "boolean" },
      cool: { type: "boolean" },
      setpoint: { type: "number", description: "0..30 °C, 0.1 askel" },
      disableMinutes: { type: "integer", description: "0=hälytykset päälle, 1..1440 pois" },
      dry_run: { type: "boolean" },
      reason: { type: "string" },
    }, []),
  fn("ack_alarms", "Kuittaa Myko-hälytyksiä (POST /api/alarms/ack). Anna ids[] tai point_id+alarm. dry_run=true = ei kirjoitusta. EI ole PLC ErrorAck.",
    {
      ids: { type: "array", items: { type: "integer" } },
      point_id: { type: "string", description: "esim. F1_PID tai ColdStorage1" },
      alarm: { type: "string", description: "esim. PID_LAHTO_JUMISSA" },
      dry_run: { type: "boolean" },
      reason: { type: "string" },
    }, []),
  fn("log_observation", "Kirjaa havainto + kunnossapitopyyntö automaattisesti (kp incidents/actions). Käytä AINA vapaan tekstin yhteydessä; älä kysy lupaa.",
    {
      system: { type: "string", description: "PLC_2 | Myko | koti" },
      device: { type: "string", description: "F1 | T1 | G_Air | ..." },
      symptom: { type: "string" },
      request: { type: "string", description: "kunnossapitopyyntö / toimenpidepyyntö" },
      status: { type: "string", enum: ["open", "resolved", "info", "closed"] },
      conditions: { type: "array", items: { type: "string" } },
    }, ["symptom"]),
];

function pack(obj) { return JSON.stringify(obj); }

export function describeWrite(name, args = {}) {
  if (name === "get_pid") return `Luen PID ${args.key} tilan`;
  if (name === "pid_cmd") {
    const parts = Object.entries(args).filter(([k]) => !["key", "dry_run", "reason"].includes(k)).map(([k, v]) => `${k}=${v}`);
    return `${args.dry_run ? "DRY-RUN " : ""}PID ${args.key}: ${parts.join(", ") || "(tyhjä)"}${args.reason ? ` (${args.reason})` : ""}`;
  }
  if (name === "set_controls") {
    const id = args.point_id || POINT_BY_KEY[args.key] || args.key;
    const parts = ["on", "heat", "cool", "setpoint", "disableMinutes"].filter((k) => args[k] !== undefined).map((k) => `${k}=${args[k]}`);
    return `${args.dry_run ? "DRY-RUN " : ""}Controls ${id}: ${parts.join(", ") || "(ei muutoksia)"}${args.reason ? ` (${args.reason})` : ""}`;
  }
  if (name === "ack_alarms") {
    const t = args.ids?.length ? `ids=${args.ids.join(",")}` : `${args.point_id || "?"}:${args.alarm || "?"}`;
    return `${args.dry_run ? "DRY-RUN " : ""}Kuittaa Myko-hälytys ${t}`;
  }
  if (name === "log_observation") return `Kirjaan havainnon: ${String(args.symptom || "").slice(0, 80)}`;
  return name;
}

function writeAudit(entry) {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(WRITE_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* ignore */ }
}

async function api(path, { method = "GET", body, actor } = {}) {
  const headers = { "Content-Type": "application/json", "x-myko-actor": actor || "telegram-atte" };
  const r = await fetch(API_BASE + path, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

function snapPid(v = {}) {
  return {
    PV: v.PV, SP: v.CSP ?? v.SP, CSP: v.CSP, OutSum: v.OutSum, OutHeat: v.OutHeat, OutCool: v.OutCool,
    ErrBits: v.ErrBits, Err: v.Err, Warn: v.Warn, State: v.State, Mode: v.Mode, ManEn: v.ManEn, ManVal: v.ManVal,
  };
}

async function readPid(key) {
  const r = await api(`/api/pid/${key}`);
  if (!r.ok) return { error: r.body?.error || `HTTP ${r.status}` };
  return { key, at: r.body.at, values: snapPid(r.body.values ?? {}), active: r.body.active };
}

function validatePidCmd(args) {
  const key = args.key;
  if (!PID_KEYS.includes(key)) throw new Error(`tuntematon PID ${key}`);
  const cmd = {};
  if (args.ErrorAck === true) cmd.ErrorAck = true;
  if ("Mode" in args || "ModeActivate" in args) {
    if (args.ModeActivate !== true) throw new Error("ModeActivate=true pakollinen Mode kanssa");
    if (![0, 3, 4].includes(args.Mode)) throw new Error("Mode sallittu vain 0, 3 tai 4 (ei tuning 1/2 Telegramista)");
    cmd.Mode = args.Mode; cmd.ModeActivate = true;
  }
  if ("ManualEnable" in args) {
    if (typeof args.ManualEnable !== "boolean") throw new Error("ManualEnable bool");
    cmd.ManualEnable = args.ManualEnable;
    if ("ManualValue" in args) {
      const v = Number(args.ManualValue);
      if (!(v >= -100 && v <= 100)) throw new Error("ManualValue -100..100");
      cmd.ManualValue = v;
    }
  }
  if (!Object.keys(cmd).length) throw new Error("pid_cmd: anna ErrorAck, Mode+ModeActivate tai ManualEnable");
  // Disallow mixing ErrorAck pulse with mode change in one call (backend allows, but clearer as steps)
  if (cmd.ErrorAck && (cmd.Mode != null || cmd.ManualEnable != null))
    throw new Error("ErrorAck erikseen; Mode/Manual eri kutsussa");
  return cmd;
}

async function doPidCmd(args, ctx) {
  const cmd = validatePidCmd(args);
  const before = await readPid(args.key);
  const summary = describeWrite("pid_cmd", { ...args, ...cmd });
  if (args.dry_run) {
    writeAudit({ kind: "dry_run", tool: "pid_cmd", who: ctx.who, chatId: ctx.chatId, text: ctx.q, action: summary, cmd, before, result: "dry_run" });
    return pack({ dry_run: true, would: cmd, before, note: "ei kirjoitettu" });
  }
  const r = await api(`/api/pid/${args.key}/cmd`, { method: "POST", body: cmd, actor: "telegram-atte" });
  // brief settle for ModeActivate / ErrorAck readback
  await new Promise((res) => setTimeout(res, 800));
  const after = await readPid(args.key);
  const result = { ok: r.ok, status: r.status, write: r.body, before, after };
  writeAudit({ kind: "write", tool: "pid_cmd", who: ctx.who, chatId: ctx.chatId, text: ctx.q, action: summary, cmd, before, after, result: r.body });
  const incident_id = await kpOpenIncidentFor([`${args.key}_PID`, POINT_BY_KEY[args.key]]).catch(() => null);
  await kpLogAction({
    incident_id, actor: "telegram-atte", action: summary,
    nodes: `/api/pid/${args.key}/cmd`, params: { cmd, reason: args.reason, chatId: ctx.chatId },
    approved_by: `telegram:${ctx.who || ctx.chatId}`, result: JSON.stringify(result).slice(0, 1500),
    worked: r.ok ? null : 0,
  }).catch(() => undefined);
  return pack(result);
}

async function doSetControls(args, ctx) {
  const key = args.key || KEY_BY_POINT[args.point_id];
  const pointId = args.point_id || POINT_BY_KEY[args.key];
  if (!pointId || !KEY_BY_POINT[pointId]) throw new Error("anna key (F1|T1|G_Air) tai point_id (ColdStorage1|Terrario1|GardenAir)");
  const body = {};
  for (const k of ["on", "heat", "cool", "setpoint", "disableMinutes"]) if (k in args) body[k] = args[k];
  if (!Object.keys(body).length) throw new Error("ei muutoksia");
  if ("setpoint" in body) {
    const s = Number(body.setpoint);
    if (!(s >= 0 && s <= 30)) throw new Error("setpoint 0..30");
    body.setpoint = Math.round(s * 10) / 10;
  }
  const beforeCtrl = await api(`/api/alarms/${pointId}/controls`);
  const beforePid = key ? await readPid(key) : null;
  const summary = describeWrite("set_controls", { ...args, point_id: pointId });
  if (args.dry_run) {
    writeAudit({ kind: "dry_run", tool: "set_controls", who: ctx.who, chatId: ctx.chatId, text: ctx.q, action: summary, body, before: beforeCtrl.body });
    return pack({ dry_run: true, point_id: pointId, would: body, before: beforeCtrl.body, beforePid, note: "ei kirjoitettu" });
  }
  const r = await api(`/api/alarms/${pointId}/controls`, { method: "PUT", body, actor: "telegram-atte" });
  await new Promise((res) => setTimeout(res, 500));
  const afterCtrl = await api(`/api/alarms/${pointId}/controls`);
  const afterPid = key ? await readPid(key) : null;
  const result = { ok: r.ok, status: r.status, write: r.body, before: beforeCtrl.body, after: afterCtrl.body, beforePid, afterPid };
  writeAudit({ kind: "write", tool: "set_controls", who: ctx.who, chatId: ctx.chatId, text: ctx.q, action: summary, body, result: r.body, after: afterCtrl.body });
  const incident_id = await kpOpenIncidentFor([`${key}_PID`, pointId]).catch(() => null);
  await kpLogAction({
    incident_id, actor: "telegram-atte", action: summary,
    nodes: `/api/alarms/${pointId}/controls`, params: { body, reason: args.reason, chatId: ctx.chatId },
    approved_by: `telegram:${ctx.who || ctx.chatId}`, result: JSON.stringify(result).slice(0, 1500),
    worked: r.ok ? null : 0,
  }).catch(() => undefined);
  return pack(result);
}

async function doAckAlarms(args, ctx) {
  let ids = Array.isArray(args.ids) ? args.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
  if (!ids.length && args.point_id && args.alarm) {
    ids = (await query(
      "SELECT id FROM alarm_events WHERE event='start' AND acked_at IS NULL AND point_id=? AND alarm=? ORDER BY id DESC LIMIT 20",
      [args.point_id, args.alarm],
    )).map((r) => Number(r.id));
  }
  if (!ids.length) throw new Error("ack_alarms: anna ids[] tai point_id+alarm (aktiivinen start-rivi)");
  const summary = describeWrite("ack_alarms", { ...args, ids });
  const body = { ids, by: `telegram (${ctx.who || "atte"})`, dryRun: Boolean(args.dry_run) };
  if (args.dry_run) {
    writeAudit({ kind: "dry_run", tool: "ack_alarms", who: ctx.who, chatId: ctx.chatId, text: ctx.q, action: summary, body });
    return pack({ dry_run: true, would: body });
  }
  const r = await api("/api/alarms/ack", { method: "POST", body, actor: "telegram-atte" });
  writeAudit({ kind: "write", tool: "ack_alarms", who: ctx.who, chatId: ctx.chatId, text: ctx.q, action: summary, body, result: r.body });
  await kpLogAction({
    incident_id: null, actor: "telegram-atte", action: summary,
    nodes: "/api/alarms/ack", params: { ids, reason: args.reason, chatId: ctx.chatId },
    approved_by: `telegram:${ctx.who || ctx.chatId}`, result: JSON.stringify(r.body).slice(0, 1000),
    worked: r.ok ? null : 0,
  }).catch(() => undefined);
  return pack({ ok: r.ok, status: r.status, ...r.body });
}

async function doLogObservation(args, ctx) {
  const symptom = String(args.symptom || "").slice(0, 4000);
  if (!symptom) throw new Error("symptom pakollinen");
  const system = String(args.system || "Myko").slice(0, 32);
  const device = args.device ? String(args.device).slice(0, 32) : null;
  const status = ["open", "resolved", "info", "closed"].includes(args.status) ? args.status : "info";
  const conditions = [...(args.conditions ?? []), "telegram-auto", ctx.chatId ? `chat:${ctx.chatId}` : null].filter(Boolean);
  const inc = await kpLogIncident({
    system, device, symptom,
    conditions, status,
    resolution: args.request ? String(args.request).slice(0, 4000) : null,
  });
  if (args.request) {
    await kpLogAction({
      incident_id: inc.id, actor: "telegram-atte",
      action: `Kunnossapitopyyntö: ${String(args.request).slice(0, 1500)}`,
      nodes: "telegram", params: { chatId: ctx.chatId, q: ctx.q },
      approved_by: `telegram:${ctx.who || ctx.chatId}`, result: "kirjattu",
    }).catch(() => undefined);
  }
  writeAudit({ kind: "log", tool: "log_observation", who: ctx.who, chatId: ctx.chatId, text: ctx.q, action: describeWrite("log_observation", args), incident_id: inc.id });
  return pack({ ok: true, incident_id: inc.id, status });
}

const IMPL = {
  get_pid: async (a) => pack(await readPid(a.key)),
  pid_cmd: doPidCmd,
  set_controls: doSetControls,
  ack_alarms: doAckAlarms,
  log_observation: doLogObservation,
};

export async function callWriteTool(name, args, ctx = {}) {
  if (!WRITE_TOOL_NAMES.has(name)) throw new Error(`tuntematon kirjoitustyökalu ${name}`);
  if (name !== "get_pid" && name !== "log_observation" && !ctx.allowWrites)
    return pack({ error: "kirjoitus kielletty: vain Atten Telegram-chat" });
  const f = IMPL[name];
  return f(args || {}, ctx);
}

export function isWriteTool(name) { return WRITE_TOOL_NAMES.has(name); }
