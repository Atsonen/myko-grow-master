// Myko -> PLC process-value feed ("Myko syöttää mittauksen").
// Reads a selectable MQTT sensor field per PID (e.g. Sensors/SensorBlock_1 . DStemp1), filters it and, only when the
// per-PID switch is ON (default OFF), writes the accepted value to PID_Temp.Input over OPC UA via the bridge
// (Myko/Cmd/<key>_PID {Input}). Rejected samples are never written: PLC keeps the last written value (hold).
// Filter: ESP error codes -127..-119, non-finite, plausibility range, spike (|Δ| > maxStep vs last good, unless the
// new level is confirmed by `confirmN` consecutive consistent samples). Alarms (reported to pid.js, PLC source):
//   SENSOR_VIKA = no accepted sample for faultS s and the latest sample was rejected (decoded error code)
//   INPUT_STALE = no successful Input write for staleS s while the feed is ON.
//   ANTURIVIKA_ALASAJO = SENSOR_VIKA/INPUT_STALE lasted > shutdownMin min -> Myko sets the point's ON switch OFF via the
//   same path as the faceplate (PUT /api/alarms/:point/controls {on:false} -> status word bit7 to the PLC), logs it, P1 alarm.
//   No auto-restart: alarm stays until the user turns ON back on.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";

export const ESP_CODES = {
  "-127": "Missing", "-126": "ReadError", "-125": "Timeout", "-124": "OutOfRange", "-123": "NotReady",
  "-122": "Disabled", "-121": "Stale", "-120": "InvalidConfig", "-119": "AmbiguousId",
};
const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, "..", "pv-feed.json");
const DEFAULTS = {
  F1: { topic: "Sensors/SensorBlock_1", field: "DStemp1", enabled: false, min: -10, max: 30 },
  T1: { topic: null, field: null, enabled: false, min: 5, max: 45 },
  G_Air: { topic: "Sensors/SensorBlock_2", field: "DStemp2", enabled: false, min: 0, max: 50 },
};
// Optional per-PID source whitelist (only these topic.field pairs may be selected). G_Air = kasvamon ilma (PF-1):
// SensorBlock_2 DStemp2/3/4 = datalogger dl03 G Mid DS2 / dl30 G Katto DS3 / dl31 G Poistoilma DS4 (verified 23.10.2026).
export const ALLOWED_SOURCES = {
  G_Air: [
    { topic: "Sensors/SensorBlock_2", field: "DStemp3", label: "Katto (G Katto DS3)", dl: "dl30" },
    { topic: "Sensors/SensorBlock_2", field: "DStemp2", label: "Keskiosa (G Mid DS2)", dl: "dl03" },
    { topic: "Sensors/SensorBlock_2", field: "DStemp4", label: "Poistoilma (G Poistoilma DS4)", dl: "dl31" },
  ],
};
const COMMON = { maxStep: 2.0, confirmN: 3, minIntervalS: 1, faultS: 30, staleS: 60, shutdownMin: 5 };

export function registerPvFeed(app, { pidCommand, pidState, query, asyncRoute, pidPoints, mqttUrl }) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { cfg = {}; }
  for (const k of Object.keys(pidPoints)) cfg[k] = { ...COMMON, ...(DEFAULTS[k] ?? { topic: null, field: null, enabled: false, min: -50, max: 100 }), ...(cfg[k] ?? {}) };
  const save = () => fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  save();
  const st = {}; // key -> status
  for (const k of Object.keys(cfg)) st[k] = { lastRaw: null, rawAt: 0, lastGood: null, goodAt: 0, reject: null, rejectAt: 0, pend: [], wroteAt: 0, wrote: null, writes: 0, writeErr: null, busy: false };
  for (const k of Object.keys(cfg)) Object.assign(st[k], { faultSince: 0, shutdown: false, onState: null });
  const port = process.env.PORT || 3010;
  async function tick() {
    const rows = await query("SELECT point_id, on_state FROM alarm_point_controls").catch(() => []);
    const on = new Map(rows.map((r) => [r.point_id, Boolean(r.on_state)]));
    for (const k of Object.keys(cfg)) {
      const s = st[k], f = cfg[k], now = Date.now(), isOn = on.get(pidPoints[k]);
      s.onState = isOn ?? null;
      if (s.shutdown && isOn) { s.shutdown = false; console.log(`[pvfeed] ${k} ON re-enabled by user, ANTURIVIKA_ALASAJO cleared`); }
      const a = alarms(k), fault = a.SENSOR_VIKA || a.INPUT_STALE;
      if (!fault || !isOn) { s.faultSince = 0; continue; }
      s.faultSince ||= now;
      if (s.shutdown || now - s.faultSince < f.shutdownMin * 60_000) continue;
      s.shutdown = true;
      const why = a.SENSOR_VIKA ? `anturivika (${s.reject ?? "?"})` : "Input ei päivity";
      console.warn(`[pvfeed] ${k} ANTURIVIKA_ALASAJO: ${why} > ${f.shutdownMin} min -> ON off`);
      await query("INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, NULL, 'control', UTC_TIMESTAMP(3), 0, NULL)",
        [pidPoints[k], `ANTURIVIKA_ALASAJO: ON off autom. (${why})`.slice(0, 80)]).catch(() => undefined);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/alarms/${pidPoints[k]}/controls`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: false }) });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
      } catch (e) { console.error(`[pvfeed] ${k} shutdown ON off FAILED`, e.message); s.writeErr = `alasajo epäonnistui: ${e.message}`; }
    }
  }
  setInterval(() => tick().catch((e) => console.error("[pvfeed] tick", e.message)), 5000);
  const catalog = new Map(); // topic -> {at, fields: {name: value}}

  const c = mqtt.connect(mqttUrl, { clientId: `myko-backend-pvfeed-${process.pid}`, reconnectPeriod: 5000 });
  c.on("connect", () => c.subscribe("Sensors/#", { qos: 0 }));
  c.on("error", (e) => console.error("[pvfeed mqtt]", e.message));
  c.on("message", (topic, buf) => {
    if (topic.startsWith("Sensors/PLC_2") || topic.startsWith("Sensors/Mykovalvomo")) return; // PLC mirror / Myko own control word
    let d; try { d = JSON.parse(buf.toString()); } catch { return; }
    if (!d || typeof d !== "object" || Array.isArray(d)) return;
    const fields = Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === "number"));
    catalog.set(topic, { at: Date.now(), fields });
    for (const [k, f] of Object.entries(cfg)) if (f.topic === topic && f.field) onSample(k, d[f.field]);
  });

  function classify(k, v) {
    const f = cfg[k], s = st[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return "NaN/puuttuu";
    const code = Math.round(v);
    if (v === code && ESP_CODES[String(code)]) return `${code} ${ESP_CODES[String(code)]}`;
    if (v < f.min || v > f.max) return `epäuskottava ${v} (sallittu ${f.min}…${f.max})`;
    if (s.lastGood !== null && Date.now() - s.goodAt < 120_000 && Math.abs(v - s.lastGood) > f.maxStep) {
      s.pend = s.pend.filter((p) => Math.abs(p - v) <= f.maxStep / 2); s.pend.push(v);
      if (s.pend.length < f.confirmN) return `piikki ${v} (Δ ${(v - s.lastGood).toFixed(2)} > ${f.maxStep})`;
    }
    return null;
  }
  async function onSample(k, v) {
    const s = st[k], f = cfg[k], now = Date.now();
    s.lastRaw = v; s.rawAt = now;
    const why = classify(k, v);
    if (why) { s.reject = why; s.rejectAt = now; return; }
    s.pend = []; s.lastGood = v; s.goodAt = now;
    if (!f.enabled || s.busy || now - s.wroteAt < f.minIntervalS * 1000) return;
    s.busy = true;
    try {
      const r = await pidCommand(k, { Input: v }, "pvfeed");
      if (r.error) s.writeErr = r.error; else { s.wroteAt = Date.now(); s.wrote = v; s.writes++; s.writeErr = null; }
    } catch (e) { s.writeErr = e.message; } finally { s.busy = false; }
  }
  // alarm conditions for pid.js (raw, pid.js debounces)
  function alarms(k) {
    const f = cfg[k], s = st[k], now = Date.now();
    const sd = s?.shutdown ? { ANTURIVIKA_ALASAJO: true } : {};
    if (!f?.enabled || !f.topic || !f.field) return sd;
    const noGood = now - (s.goodAt || 0) > f.faultS * 1000;
    return {
      SENSOR_VIKA: noGood && s.rejectAt > (s.goodAt || 0),
      INPUT_STALE: now - (s.wroteAt || 0) > f.staleS * 1000, ...sd,
    };
  }
  const status = (k) => {
    const s = st[k], v = pidState(k)?.values ?? {};
    return { ...cfg[k], lastRaw: s.lastRaw, rawAt: s.rawAt || null, lastGood: s.lastGood, goodAt: s.goodAt || null, reject: s.reject, rejectAt: s.rejectAt || null,
      wrote: s.wrote, wroteAt: s.wroteAt || null, writes: s.writes, writeErr: s.writeErr, plcInput: v.PV ?? null, alarms: alarms(k), faultSince: s.faultSince || null, shutdown: s.shutdown, onState: s.onState };
  };

  app.get("/api/pid/:key/feed", asyncRoute(async (req, res) => {
    const k = req.params.key; if (!cfg[k]) return res.status(404).json({ error: "Unknown PID" });
    const sources = [...catalog.entries()].sort().flatMap(([t, e]) => Object.entries(e.fields).map(([fl, val]) => ({ topic: t, field: fl, value: val, at: new Date(e.at).toISOString() })));
    const allowed = ALLOWED_SOURCES[k];
    const list = allowed
      ? allowed.map((a) => { const e = catalog.get(a.topic); return { topic: a.topic, field: a.field, label: a.label, dl: a.dl, value: e?.fields[a.field] ?? null, at: e ? new Date(e.at).toISOString() : null }; })
      : sources;
    res.json({ key: k, feed: status(k), codes: ESP_CODES, sources: list, restricted: Boolean(allowed) });
  }));
  // PUT {topic?, field?, enabled?, min?, max?}
  app.put("/api/pid/:key/feed", asyncRoute(async (req, res) => {
    const k = req.params.key; if (!cfg[k]) return res.status(404).json({ error: "Unknown PID" });
    const b = req.body ?? {}, n = { ...cfg[k] };
    if ("topic" in b || "field" in b) {
      if (b.topic === null) { n.topic = null; n.field = null; }
      else {
        if (typeof b.topic !== "string" || !/^Sensors\/[\w\-/]+$/.test(b.topic) || b.topic.startsWith("Sensors/PLC_2")) return res.status(400).json({ error: "bad topic" });
        if (typeof b.field !== "string" || !/^[\w\-]+$/.test(b.field)) return res.status(400).json({ error: "bad field" });
        if (ALLOWED_SOURCES[k] && !ALLOWED_SOURCES[k].some((a) => a.topic === b.topic && a.field === b.field)) return res.status(400).json({ error: "lähde ei sallittu tälle säätimelle" });
        n.topic = b.topic; n.field = b.field;
      }
    }
    if ("enabled" in b) { if (typeof b.enabled !== "boolean") return res.status(400).json({ error: "enabled bool" }); n.enabled = b.enabled; }
    if ("shutdownMin" in b) { if (typeof b.shutdownMin !== "number" || !(b.shutdownMin >= 1 && b.shutdownMin <= 120)) return res.status(400).json({ error: "shutdownMin 1..120" }); n.shutdownMin = b.shutdownMin; }
    for (const x of ["min", "max"]) if (x in b) { if (typeof b[x] !== "number" || !Number.isFinite(b[x])) return res.status(400).json({ error: `${x} number` }); n[x] = b[x]; }
    if (n.min >= n.max) return res.status(400).json({ error: "min < max" });
    if (n.enabled && (!n.topic || !n.field)) return res.status(400).json({ error: "valitse lähde ensin" });
    const changed = Object.keys(b).filter((x) => JSON.stringify(n[x]) !== JSON.stringify(cfg[k][x]));
    if ((n.topic !== cfg[k].topic || n.field !== cfg[k].field)) Object.assign(st[k], { lastGood: null, goodAt: 0, pend: [], reject: null, rejectAt: 0, lastRaw: null });
    cfg[k] = n; save();
    const label = `PV-syöttö ${changed.map((x) => x === "enabled" ? `päällä=${n.enabled ? 1 : 0}` : x === "topic" || x === "field" ? `lähde=${n.topic ?? "-"}.${n.field ?? "-"}` : `${x}=${n[x]}`).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "ei muutosta"}`.slice(0, 80);
    await query("INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, NULL, 'control', UTC_TIMESTAMP(3), NULL, NULL)", [pidPoints[k], label]).catch(() => undefined);
    console.log(`[pvfeed] ${k} ${label}`);
    res.json({ key: k, feed: status(k) });
  }));
  return { feedAlarms: alarms };
}
