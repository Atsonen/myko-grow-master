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
import { notifyAlert } from "./notifyAlert.js";

const TOPIC = "Sensors/PLC_2/FillPump";
const CMD_TOPIC = "Myko/Cmd/FillPump";
const WRITE_ALLOWED = true; // hyväksytty 1.11.2026
const ERR = { 0: "ok", 1: "Maksimitäyttöaika ylittyi", 2: "Pinta-anturivika" };
const STATE_PATH = "/home/atte/.config/myko/fillpump_alarm_state.json";
const HIST_PATH = "/home/atte/.config/myko/fillpump_level_hist.json";
const EVENTS_PATH = "/home/atte/.config/myko/fillpump_events.json";
const HB_DELAY_MS = 45_000; // debounce heartbeat (30–60 s)
const ERR_DELAY_MS = 10_000; // St_Error on jo PLC:n päättämä vika – lyhyt varmistus
const HIST_KEEP_MS = 24 * 3600_000; // ~24 h minute buckets
/** Break / backfill threshold: missing > ~2.5 min between minute buckets. */
export const HIST_GAP_MS = 150_000;
const DL_LEVEL_KEY = "dl25"; // same tank level as FillPump (numeric_value %, timestamps UTC)
const EVENTS_KEEP = 80;
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

/** @type {{ t: number, v: number }[]} minute-bucket level history (~24 h) */
let hist = [];
try {
  const j = JSON.parse(fs.readFileSync(HIST_PATH, "utf8"));
  if (Array.isArray(j)) {
    hist = j.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v)).map((p) => (
      p.bf ? { t: p.t, v: p.v, bf: true } : { t: p.t, v: p.v }
    ));
  }
} catch { /* first run */ }

/** @type {{ ts: string, kind: string, text: string, code?: string }[]} */
let events = [];
try {
  const j = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
  if (Array.isArray(j)) events = j.slice(-EVENTS_KEEP);
} catch { /* first run */ }

const saveHist = () => {
  try {
    fs.mkdirSync("/home/atte/.config/myko", { recursive: true });
    fs.writeFileSync(HIST_PATH + ".tmp", JSON.stringify(hist));
    fs.renameSync(HIST_PATH + ".tmp", HIST_PATH);
  } catch (e) { console.warn("[fillpump] hist", e.message); }
};
const saveEvents = () => {
  try {
    fs.mkdirSync("/home/atte/.config/myko", { recursive: true });
    fs.writeFileSync(EVENTS_PATH + ".tmp", JSON.stringify(events.slice(-EVENTS_KEEP)));
    fs.renameSync(EVENTS_PATH + ".tmp", EVENTS_PATH);
  } catch (e) { console.warn("[fillpump] events", e.message); }
};

/** Atomic persist of hist (+ events/alarms). Safe to call from SIGTERM/SIGINT. */
export function persistFillPumpState() {
  saveHist();
  saveEvents();
  saveSt();
}

function pushEvent(kind, text, code) {
  events.push({ ts: new Date().toISOString(), kind, text: String(text).slice(0, 200), ...(code ? { code } : {}) });
  events = events.slice(-EVENTS_KEEP);
  saveEvents();
}

function pruneHist(now = Date.now()) {
  const cut = now - HIST_KEEP_MS;
  if (hist.length > 10 && hist[0].t < cut) hist = hist.filter((p) => p.t >= cut);
}

/**
 * Merge minute-bucket DL points into hist across gaps (> gapMs).
 * Backfilled points get `{ bf: true }`. Pure — used by startup backfill + tests.
 * @param {{ t: number, v: number, bf?: boolean }[]} cur
 * @param {{ t: number, v: number }[]} dlBuckets minute-aligned
 */
export function backfillHistGaps(cur, dlBuckets, opts = {}) {
  const gapMs = opts.gapMs ?? HIST_GAP_MS;
  const now = opts.now ?? Date.now();
  const keepMs = opts.keepMs ?? HIST_KEEP_MS;
  const cut = opts.cut ?? now - keepMs;
  /** @type {Map<number, { t: number, v: number, bf?: boolean }>} */
  const byT = new Map();
  for (const p of cur ?? []) {
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.v) || p.t < cut) continue;
    byT.set(p.t, p.bf ? { t: p.t, v: p.v, bf: true } : { t: p.t, v: p.v });
  }
  /** @type {Map<number, number>} */
  const dl = new Map();
  for (const p of dlBuckets ?? []) {
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.v) || p.t < cut || p.t > now) continue;
    const m = Math.floor(p.t / 60_000) * 60_000;
    dl.set(m, p.v);
  }
  const times = [...byT.keys()].sort((a, b) => a - b);
  /** @type {[number, number, "open" | "closed"][]} g0..g1; "closed" includes g0 (empty/leading window). */
  const gaps = [];
  if (!times.length) {
    gaps.push([cut, now, "closed"]);
  } else {
    if (times[0] - cut > gapMs) gaps.push([cut, times[0], "closed"]); // include cut..first-
    for (let i = 0; i < times.length - 1; i++) {
      if (times[i + 1] - times[i] > gapMs) gaps.push([times[i], times[i + 1], "open"]);
    }
    if (now - times[times.length - 1] > gapMs) gaps.push([times[times.length - 1], now, "open"]);
  }
  let added = 0;
  for (const [g0, g1, mode] of gaps) {
    for (const [t, v] of dl) {
      const inGap = mode === "closed" ? (t >= g0 && t <= g1) : (t > g0 && t <= g1);
      if (inGap && !byT.has(t)) {
        byT.set(t, { t, v, bf: true });
        added++;
      }
    }
  }
  const out = [...byT.values()].sort((a, b) => a.t - b.t);
  return { hist: out, added, gaps: gaps.length };
}

/** Bucket raw DL rows (ms timestamps) to 1 min. */
export function bucketDlMinutes(rows) {
  /** @type {{ t: number, v: number }[]} */
  const byMin = [];
  for (const r of rows ?? []) {
    const tRaw = Number(r.t);
    const v = Number(r.v);
    if (!Number.isFinite(tRaw) || !Number.isFinite(v)) continue;
    const t = Math.floor(tRaw / 60_000) * 60_000;
    if (!byMin.length || byMin[byMin.length - 1].t !== t) byMin.push({ t, v });
    else byMin[byMin.length - 1].v = v;
  }
  return byMin;
}

async function backfillFromDl25() {
  try {
    const { query } = await import("./db.js");
    // DATETIME is UTC; pool session time_zone=+00:00 (db.js TZ=UTC). Use numeric_value (dl25 scale 0.01 → %).
    const rows = await query(
      `SELECT UNIX_TIMESTAMP(timestamp) * 1000 AS t, CAST(numeric_value AS DECIMAL(12,3)) AS v
       FROM datalogger_values
       WHERE variable_key = ? AND timestamp > UTC_TIMESTAMP() - INTERVAL 25 HOUR
       ORDER BY timestamp`,
      [DL_LEVEL_KEY],
    );
    const buckets = bucketDlMinutes(rows);
    const now = Date.now();
    const { hist: merged, added, gaps } = backfillHistGaps(hist, buckets, { now, keepMs: HIST_KEEP_MS, gapMs: HIST_GAP_MS });
    hist = merged;
    pruneHist(now);
    if (added > 0) {
      saveHist();
      console.log(`[fillpump] trend backfill ${DL_LEVEL_KEY}: +${added} pts across ${gaps} gap(s) → ${hist.length} pts`);
    } else {
      console.log(`[fillpump] trend backfill ${DL_LEVEL_KEY}: no gaps to fill (${buckets.length} dl min, hist ${hist.length})`);
    }
  } catch (e) {
    console.warn("[fillpump] trend backfill", e.message);
  }
}

function sampleLevel(plc) {
  const v = Number(plc?.Level ?? plc?.St_Level);
  if (!Number.isFinite(v)) return;
  const now = Date.now();
  const m = Math.floor(now / 60_000) * 60_000;
  const last = hist.length ? hist[hist.length - 1] : null;
  if (!last || last.t !== m) {
    hist.push({ t: m, v });
    pruneHist(now);
    saveHist(); // new minute bucket → persist immediately (survives crash better)
  } else {
    last.v = v;
    if (last.bf) delete last.bf; // live sample replaces backfill mark
  }
}

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
  await notifyAlert(text, { tag: "fillpump " });
}
async function notifySafe(t) {
  const r = await notifyAlert(t, { tag: "fillpump " });
  if (!r.ok) console.warn("[fillpump] notify fail", r.error || r.channel);
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
        pushEvent("alarm", msg, key);
        await notifySafe(`🚨 ${msg} (ilmoitetaan kerran, palautumisesta erikseen)`);
      }
    } else if (!bad) {
      delete st.since[key];
      if (st.active[key]) {
        st.active[key] = false;
        console.log(`[fillpump] clear ${key}`);
        pushEvent("info", `Palautui: ${st.msg[key] ?? msg}`, key);
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

let _shutdownHooked = false;
function hookFillPumpShutdown() {
  if (_shutdownHooked) return;
  _shutdownHooked = true;
  const onSig = (sig) => {
    try {
      console.log(`[fillpump] ${sig} → persist hist/events/alarms`);
      persistFillPumpState();
    } catch (e) { console.warn("[fillpump] shutdown persist", e?.message ?? e); }
  };
  process.on("SIGTERM", () => onSig("SIGTERM"));
  process.on("SIGINT", () => onSig("SIGINT"));
}

export function startFillPump({ mqttUrl }) {
  hookFillPumpShutdown();
  const mq = mqtt.connect(mqttUrl, { clientId: `myko-backend-fillpump-${process.pid}`, reconnectPeriod: 5000 });
  MQ = mq;
  mq.on("connect", () => { mq.subscribe(TOPIC); mq.subscribe(CMD_TOPIC + "/ack"); });
  mq.on("message", (t, buf) => {
    try {
      const j = JSON.parse(buf.toString());
      if (t === TOPIC) { S.plc = j; S.at = Date.now(); sampleLevel(j); }
      else if (j?.id && PENDING.has(j.id)) { PENDING.get(j.id)(j); PENDING.delete(j.id); }
    } catch { /* ignore */ }
  });
  mq.on("error", () => undefined);
  // Startup: fill hist gaps from datalogger dl25 (UTC), like fertdose EC backfill.
  backfillFromDl25().catch((e) => console.warn("[fillpump] backfill", e?.message ?? e));
  // Periodic persist (value updates within a minute bucket do not always save).
  setInterval(() => { try { saveHist(); } catch { /* ignore */ } }, 60_000);
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
    if (!stale && p.present) sampleLevel(p); // keep minute bucket fresh even if MQTT quiet
    const cut = Date.now() - HIST_KEEP_MS;
    const slice = hist.filter((h) => h.t >= cut);
    const trend = slice.map((h) => [h.t, h.v]);
    const trend_backfilled = slice.filter((h) => h.bf).length;
    res.json({
      plc: p,
      plc_at: S.at ? new Date(S.at).toISOString() : null,
      stale,
      present: !!p.present && !stale,
      write_allowed: WRITE_ALLOWED,
      write_note: "FillPump Cfg_*/Cmd_Ack hyväksytty; ei startup-synkkaa. Kirjoitus vain UI:sta confirm: true.",
      err_codes: ERR,
      allowed_writes: Object.keys(ALLOWED),
      trend,
      trend_backfilled,
      trend_gap_ms: HIST_GAP_MS,
      events: events.slice().reverse(),
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
      const by = String(req.body?.by ?? "myko-ui");
      pushEvent("cmd", `Kirjoitus ${Object.keys(v.ok).join(",")} by ${by}`);
      if (v.ok.Cmd_Ack) pushEvent("ack", "Cmd_Ack → TRUE (kuittaus)", "Cmd_Ack");
      res.json({ ok: true, results, by });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });
}
