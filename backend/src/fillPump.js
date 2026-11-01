// FB_FillPump – Pumput_DB.Static.FillPump (1.11.2026).
// LUKU: opcua-bridge -> MQTT Sensors/PLC_2/FillPump.
// KIRJOITUS (hyväksytty 1.11.2026, vain UI): Cfg_Enable, Cfg_LvlSP (0–100), Cfg_Hyst (0–20),
//   Cfg_MaxRun_s (10–3600), Cfg_LvlMin/Cfg_LvlMax (0–100), Cmd_Ack (TRUE; PLC nollaa).
// EI startup-/tick-synkkaa – mitään ei kirjoiteta käynnistyksessä.
//
// Hälytykset (1.11.2026): sama malli kuin kasvamoAlarms – Telegram Valvomo-botilla kerran
// alkuun + kerran palautuessa, rivit /api/alarms/summary:ssa (fillPumpAlarmRows).
//   err_1  St_Error && ErrCode=1  "Täyttöpumppu: maksimitäyttöaika ylittyi (säiliö tyhjä?)"
//   err_2  St_Error && ErrCode=2  "Täyttöpumppu: pinta-anturivika"
//   hb     HbOk===false          "Täyttöpumppu: heartbeat puuttuu" (debounce 45 s)
import fs from "node:fs";
import mqtt from "mqtt";
import { tg, allowedChats } from "./telegram.js";

const TOPIC = "Sensors/PLC_2/FillPump";
const CMD_TOPIC = "Myko/Cmd/FillPump";
const WRITE_ALLOWED = true; // hyväksytty 1.11.2026
const ERR = { 0: "ok", 1: "Maksimitäyttöaika ylittyi", 2: "Pinta-anturivika" };
const STATE_PATH = "/home/atte/.config/myko/fillpump_alarm_state.json";
const HB_DELAY_MS = 45_000; // debounce heartbeat (30–60 s)
const ERR_DELAY_MS = 10_000; // St_Error on jo PLC:n päättämä vika – lyhyt varmistus
const ALLOWED = {
  Cfg_Enable: { type: "bool" },
  Cfg_LvlSP: { type: "float", min: 0, max: 100 },
  Cfg_Hyst: { type: "float", min: 0, max: 20 },
  Cfg_MaxRun_s: { type: "int", min: 10, max: 3600 },
  Cfg_LvlMin: { type: "float", min: 0, max: 100 },
  Cfg_LvlMax: { type: "float", min: 0, max: 100 },
  Cmd_Ack: { type: "ack" }, // vain TRUE / pulse
};

const TEXTS = {
  err_1: "Täyttöpumppu: maksimitäyttöaika ylittyi (säiliö tyhjä?)",
  err_2: "Täyttöpumppu: pinta-anturivika",
  hb: "Täyttöpumppu: heartbeat puuttuu",
};

let MQ = null;
const PENDING = new Map();
const S = { plc: { present: false }, at: 0 };
/** @type {{ active: Record<string, boolean>, since: Record<string, number>, at: Record<string, number>, msg: Record<string, string>, acked: Record<string, {at:string,by:string}> }} */
let st = { active: {}, since: {}, at: {}, msg: {}, acked: {} };
try {
  const j = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  st = { active: {}, since: {}, at: {}, msg: {}, acked: {}, ...j };
} catch { /* first run */ }

const saveSt = () => {
  try {
    fs.mkdirSync("/home/atte/.config/myko", { recursive: true });
    fs.writeFileSync(STATE_PATH + ".tmp", JSON.stringify(st));
    fs.renameSync(STATE_PATH + ".tmp", STATE_PATH);
  } catch (e) { console.warn("[fillpump] state", e.message); }
};

function cmd(body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!MQ?.connected) return resolve(null);
    const id = `fp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const to = setTimeout(() => { PENDING.delete(id); resolve(null); }, timeoutMs);
    PENDING.set(id, (j) => { clearTimeout(to); resolve(j); });
    MQ.publish(CMD_TOPIC, JSON.stringify({ id, by: "myko-ui", ...body }), { qos: 1 });
  });
}

function validate(body) {
  const out = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (["confirm", "by"].includes(k)) continue;
    const a = ALLOWED[k];
    if (!a) return { error: `ei sallittu: ${k}` };
    if (a.type === "bool") {
      if (typeof v !== "boolean") return { error: `${k}: bool` };
      out[k] = v;
    } else if (a.type === "ack") {
      if (v !== true && v !== "pulse") return { error: `${k}: odottaa true/pulse` };
      out[k] = true;
    } else if (a.type === "float") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < a.min || n > a.max) return { error: `${k}: ${a.min}–${a.max}` };
      out[k] = n;
    } else if (a.type === "int") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < a.min || n > a.max) return { error: `${k}: ${a.min}–${a.max} (kokonaisluku)` };
      out[k] = n;
    }
  }
  if (!Object.keys(out).length) return { error: "ei kirjoitettavia kenttiä" };
  return { ok: out };
}

async function notify(text) {
  for (const chat_id of await allowedChats()) await tg("sendMessage", { chat_id, text });
}
async function notifySafe(t) {
  for (let i = 0; i < 3; i++) {
    try { await notify(t); return; }
    catch (e) { console.warn("[fillpump] telegram", e.message); await new Promise((r) => setTimeout(r, 5000 * (i + 1))); }
  }
}

// Negatiiviset id:t hälytyslistaan: -1.85e9..-1.89e9 (fert -2e9, kasvamo -1.9e9, disabled -1.8e9).
const fpId = (k) => {
  let h = 0;
  for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return -(1_850_000_000 + (h % 40_000_000)); // -1.85e9..-1.89e9 (kasvamo -1.9e9, disabled -1.8e9)
};

function conditions() {
  const fresh = S.at && Date.now() - S.at < 30_000;
  const p = S.plc || {};
  const present = !!p.present && fresh;
  const out = {};
  if (!present) {
    // Ei dataa → älä nosta uusia; HB-viive nollataan. Aktiiviset virheet jäävät kunnes St_Error=false.
    out.hb = [false, TEXTS.hb];
    return out;
  }
  const err = p.St_Error === true;
  const code = Number(p.St_ErrCode);
  out.err_1 = [err && code === 1, TEXTS.err_1];
  out.err_2 = [err && code === 2, TEXTS.err_2];
  // HbOk false (tai St_HbOk false jos HbOk puuttuu)
  const hbOk = p.HbOk !== undefined ? p.HbOk : p.St_HbOk;
  out.hb = [hbOk === false, TEXTS.hb];
  return out;
}

async function evalAlarms() {
  const now = Date.now();
  const cond = conditions();
  for (const [key, [bad, msg]] of Object.entries(cond)) {
    const delay = key === "hb" ? HB_DELAY_MS : ERR_DELAY_MS;
    if (bad && !st.active[key]) {
      st.since[key] ??= now;
      if (now - st.since[key] >= delay) {
        st.active[key] = true;
        st.msg[key] = msg;
        st.at[key] = now;
        if (st.acked) delete st.acked[key];
        console.log(`[fillpump] ALARM ${key}: ${msg}`);
        await notifySafe(`🚨 ${msg} (ilmoitetaan kerran, palautumisesta erikseen)`);
      }
    } else if (!bad) {
      delete st.since[key];
      if (st.active[key]) {
        st.active[key] = false;
        console.log(`[fillpump] clear ${key}`);
        // St_Error false (yleensä Cmd_Ack:n jälkeen) / HB palautui
        await notifySafe(`✅ Palautui: ${st.msg[key] ?? msg}`);
      }
    }
  }
  // Jos St_Error pois mutta jokin err_* jäi (esim. koodi vaihtui), siivoa muut err_*-t
  const p = S.plc || {};
  if (p.present && p.St_Error !== true) {
    for (const key of ["err_1", "err_2"]) {
      if (st.active[key] && !cond[key]?.[0]) {
        // already handled above
      }
    }
  }
  saveSt();
}

export function fillPumpAlarmRows() {
  return Object.entries(st.active).filter(([, v]) => v).map(([k]) => ({
    id: fpId(k),
    pointId: "Kasvamo_FillPump",
    pointName: "Kasvamo · Täyttöpumppu",
    unit: "",
    alarm: `FILLPUMP_${k.toUpperCase()}`,
    bit: null,
    priority: 1,
    start: new Date(st.at?.[k] ?? Date.now()).toISOString(),
    end: null,
    active: true,
    value: null,
    endValue: null,
    source: "Kasvamo",
    desc: String(st.msg[k] ?? TEXTS[k] ?? k),
    acked: Boolean(st.acked?.[k]),
    ackedAt: st.acked?.[k]?.at ?? null,
    ackedBy: st.acked?.[k]?.by ?? null,
    ackRequired: true,
  }));
}

export function fillPumpAck(ids, by) {
  let n = 0;
  st.acked ??= {};
  for (const [k, v] of Object.entries(st.active)) {
    if (v && !st.acked[k] && ids.includes(fpId(k))) {
      st.acked[k] = { at: new Date().toISOString(), by: String(by ?? "dashboard").slice(0, 80) };
      n++;
      console.log(`[fillpump] ack ${k} by ${by}`);
    }
  }
  if (n) saveSt();
  return n;
}

export function fillPumpActiveAlarms() {
  return Object.entries(st.active).filter(([, v]) => v).map(([k]) => st.msg[k] ?? k);
}

export function startFillPump({ mqttUrl }) {
  const mq = mqtt.connect(mqttUrl, { clientId: `myko-backend-fillpump-${process.pid}`, reconnectPeriod: 5000 });
  MQ = mq;
  mq.on("connect", () => { mq.subscribe(TOPIC); mq.subscribe(CMD_TOPIC + "/ack"); });
  mq.on("message", (t, buf) => {
    try {
      const j = JSON.parse(buf.toString());
      if (t === TOPIC) { S.plc = j; S.at = Date.now(); }
      else if (j?.id && PENDING.has(j.id)) { PENDING.get(j.id)(j); PENDING.delete(j.id); }
    } catch { /* ignore */ }
  });
  mq.on("error", () => undefined);
  // Hälytysarvio ~10 s (ei PLC-kirjoituksia). Viiveet ERR_DELAY_MS / HB_DELAY_MS.
  setTimeout(() => {
    evalAlarms().catch((e) => console.warn("[fillpump] alarm", e.message));
    setInterval(() => evalAlarms().catch((e) => console.warn("[fillpump] alarm", e.message)), 10_000);
  }, 15_000);
}

export function registerFillPumpRoutes(app) {
  app.get("/api/fillpump", (_req, res) => {
    const stale = !S.at || Date.now() - S.at > 30_000;
    const p = S.plc || {};
    res.json({
      plc: p,
      plc_at: S.at ? new Date(S.at).toISOString() : null,
      stale,
      present: !!p.present && !stale,
      write_allowed: WRITE_ALLOWED,
      write_note: "FillPump Cfg_*/Cmd_Ack hyväksytty; ei startup-synkkaa. Kirjoitus vain UI:sta confirm: true.",
      err_codes: ERR,
      allowed_writes: Object.keys(ALLOWED),
      alarms: {
        active: Object.fromEntries(Object.entries(st.active).filter(([, v]) => v)),
        texts: TEXTS,
        hb_delay_s: HB_DELAY_MS / 1000,
        err_delay_s: ERR_DELAY_MS / 1000,
      },
    });
  });

  app.post("/api/fillpump", async (req, res) => {
    try {
      if (!WRITE_ALLOWED) return res.status(403).json({ error: "FillPump-kirjoitus ei käytössä" });
      if (req.body?.confirm !== true) return res.status(400).json({ error: "vahvistus puuttuu (confirm: true)" });
      const v = validate(req.body);
      if (v.error) return res.status(400).json({ error: v.error });
      const ack = await cmd(v.ok);
      if (!ack) return res.status(504).json({ error: "Ei kuittausta bridgeltä (Myko/Cmd/FillPump/ack)" });
      const results = ack.results || {};
      const bad = Object.entries(results).find(([, r]) => !r || r.result === undefined || !String(r.result).startsWith("ok"));
      if (bad) return res.status(502).json({ error: String(bad[1] ?? "tuntematon"), ack });
      res.json({ ok: true, results, by: String(req.body?.by ?? "myko-ui") });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });
}
