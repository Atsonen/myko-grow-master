// Edge-based pump run intervals from live PLC MQTT (~1 s bridge poll).
// CircPump_L/R: Status bit0 (X0) / Running; FillPump: Pump|St_Running; FertDose: DoseActive.
// No PLC writes. Persist closed+open intervals to JSON; GET /api/pump-runs?from=&to=.
import fs from "node:fs";
import mqtt from "mqtt";
import { query } from "./db.js";

const STATE_PATH = "/home/atte/.config/myko/pump_runs.json";
const KEEP_MS = 14 * 24 * 3600_000; // 14 d
const TOPICS = {
  sequence: "Sensors/PLC_2/Sequence",
  fill: "Sensors/PLC_2/FillPump",
  fert: "Sensors/PLC_2/FertDose",
};

/** @typedef {{ id: string, label: string, color: string }} PumpMeta */
/** @type {PumpMeta[]} */
export const PUMPS = [
  { id: "circ_l", label: "Kiertopumppu L", color: "#34d399" },
  { id: "circ_r", label: "Kiertopumppu R", color: "#38bdf8" },
  { id: "fill", label: "Täyttöpumppu", color: "#fbbf24" },
  { id: "fert", label: "Lannoite", color: "#c084fc" },
];

/** @type {Record<string, boolean>} */
const lastOn = { circ_l: false, circ_r: false, fill: false, fert: false };
/** @type {Record<string, number|null>} */
const openAt = { circ_l: null, circ_r: null, fill: null, fert: null };
/** @type {{ pump: string, start: number, end: number }[]} */
let closed = [];
let dirty = false;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (Array.isArray(j.closed)) {
      closed = j.closed
        .filter((r) => r && typeof r.pump === "string" && Number.isFinite(r.start) && Number.isFinite(r.end))
        .map((r) => ({ pump: r.pump, start: Number(r.start), end: Number(r.end) }));
    }
    if (j.open && typeof j.open === "object") {
      for (const id of Object.keys(openAt)) {
        const t = Number(j.open[id]);
        if (Number.isFinite(t) && t > 0) {
          openAt[id] = t;
          lastOn[id] = true;
        }
      }
    }
    prune(false);
  } catch { /* first run */ }
}

function save() {
  try {
    fs.mkdirSync("/home/atte/.config/myko", { recursive: true });
    const open = {};
    for (const [k, v] of Object.entries(openAt)) if (v) open[k] = v;
    const tmp = STATE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ open, closed, savedAt: new Date().toISOString() }));
    fs.renameSync(tmp, STATE_PATH);
    dirty = false;
  } catch (e) {
    console.warn("[pumpruns] save", e.message);
  }
}

function prune(doSave = true) {
  const cut = Date.now() - KEEP_MS;
  const n = closed.length;
  closed = closed.filter((r) => r.end >= cut);
  if (doSave && closed.length !== n) save();
}

function bit0(status) {
  const n = Number(status);
  return Number.isFinite(n) && (n & 1) === 1;
}

/** @param {string} id @param {boolean} on @param {number} [t] */
function edge(id, on, t = Date.now()) {
  if (on === lastOn[id]) return;
  lastOn[id] = on;
  if (on) {
    if (!openAt[id]) openAt[id] = t;
  } else {
    const start = openAt[id];
    openAt[id] = null;
    if (start != null && t > start) {
      closed.push({ pump: id, start, end: t });
      if (closed.length > 50_000) closed = closed.slice(-40_000);
    }
  }
  dirty = true;
}

function fromSequence(j) {
  const t = Date.now();
  // Status X0 = bit0 Running; fallback Running/Pump
  edge("circ_l", bit0(j.L_Status) || j.L_Running === true || j.L_Pump === true, t);
  edge("circ_r", bit0(j.R_Status) || j.R_Running === true || j.R_Pump === true, t);
}

function fromFill(j) {
  edge("fill", j.Pump === true || j.St_Running === true);
}

let lastDoseCount = null;

function fromFert(j) {
  // DoseActive ~1 s jää helposti 1 s MQTT-pollauksessa väliin → myös Pump + DoseCount.
  const active = j.DoseActive === true || j.Pump === true;
  edge("fert", active);
  const dc = Number(j.DoseCount);
  if (Number.isFinite(dc)) {
    if (lastDoseCount != null && dc > lastDoseCount && !lastOn.fert) {
      const ms = Math.max(500, Number(j.LastDose_ms) || 1000);
      const end = Date.now();
      noteFertDose(ms, end);
    }
    lastDoseCount = dc;
  }
}

/** Kirjaa lannoiteannoksen käynnin (kiinteä kesto). Dedup ~5 s ikkunalla. */
export function noteFertDose(ms, endTs = Date.now()) {
  const dur = Math.max(500, Number(ms) || 1000);
  const end = Number(endTs) || Date.now();
  const start = end - dur;
  // älä tuplaa jos sama/overlapping fert-interval jo olemassa
  for (const r of closed) {
    if (r.pump !== "fert") continue;
    if (Math.abs(r.start - start) < 5000 || Math.abs(r.end - end) < 5000) return;
    if (start <= r.end && end >= r.start) return;
  }
  if (openAt.fert && Math.abs(openAt.fert - start) < 5000) return;
  closed.push({ pump: "fert", start, end });
  if (closed.length > 50_000) closed = closed.slice(-40_000);
  dirty = true;
}

/** Käynnistyksessä: täydennä puuttuvat fert-käynnit fert_dose_logista (DoseActive-missit). */
export function seedFertDosesFromLog(rows) {
  let n = 0;
  for (const r of rows || []) {
    const t = Number(r.t); const ms = Number(r.ms) || 1000;
    if (!Number.isFinite(t) || t <= 0) continue;
    const before = closed.length;
    noteFertDose(ms, t + ms); // ts = lähetyksen hetki → start=t, end=t+ms
    if (closed.length > before) n++;
  }
  if (n) { dirty = true; save(); console.log(`[pumpruns] seeded ${n} fert doses from log`); }
}

async function seedFertFromDb() {
  try {
    const rows = await query(
      `SELECT UNIX_TIMESTAMP(ts) * 1000 AS t, COALESCE(actual_ms, requested_ms) AS ms
       FROM fert_dose_log WHERE mode = 'live' AND requested_ms > 0
         AND ts > UTC_TIMESTAMP() - INTERVAL 14 DAY ORDER BY ts`);
    seedFertDosesFromLog(rows.map((r) => ({ t: Number(r.t), ms: Number(r.ms) || 1000 })));
  } catch (e) {
    console.warn("[pumpruns] seedFertFromDb", e.message);
  }
}

export function startPumpRuns({ mqttUrl }) {
  load();
  seedFertFromDb(); // DoseActive-missit → täydennä fert_dose_logista load():n jälkeen
  const mq = mqtt.connect(mqttUrl, {
    clientId: `myko-backend-pumpruns-${process.pid}`,
    reconnectPeriod: 5000,
  });
  mq.on("connect", () => {
    mq.subscribe([TOPICS.sequence, TOPICS.fill, TOPICS.fert], { qos: 0 });
    console.log("[pumpruns] subscribed Sequence/FillPump/FertDose");
  });
  mq.on("message", (topic, buf) => {
    try {
      const j = JSON.parse(buf.toString());
      if (topic === TOPICS.sequence) fromSequence(j);
      else if (topic === TOPICS.fill) fromFill(j);
      else if (topic === TOPICS.fert) fromFert(j);
    } catch { /* ignore */ }
  });
  mq.on("error", () => undefined);
  setInterval(() => prune(true), 3600_000);
  setInterval(() => { if (dirty) save(); else save(); }, 60_000); // durable open runs
}

/** Live-annokset fert_dose_logista → overlay (DoseActive-MQTT jää usein väliin). */
async function fertIntervalsFromLog(from, to) {
  const rows = await query(
    `SELECT UNIX_TIMESTAMP(ts) * 1000 AS t, COALESCE(actual_ms, requested_ms) AS ms
     FROM fert_dose_log
     WHERE mode = 'live' AND requested_ms > 0
       AND ts >= FROM_UNIXTIME(? / 1000) - INTERVAL 1 MINUTE
       AND ts <= FROM_UNIXTIME(? / 1000) + INTERVAL 1 MINUTE
     ORDER BY ts`,
    [from, to],
  );
  return rows.map((r) => {
    const start = Number(r.t);
    const ms = Math.max(500, Number(r.ms) || 1000);
    const end = start + ms;
    return {
      pump: "fert",
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      startMs: start,
      endMs: end,
      duration_s: ms / 1000,
      source: "fert_dose_log",
    };
  }).filter((iv) => Number.isFinite(iv.startMs) && iv.endMs >= from && iv.startMs <= to);
}

function mergeFertLog(intervals, logFert) {
  const out = intervals.filter((i) => i.pump !== "fert");
  const edgeFert = intervals.filter((i) => i.pump === "fert");
  // Prefer log as source of truth for fert; keep edge-only runs that don't match a log row (±5 s).
  for (const lf of logFert) {
    out.push(lf);
  }
  for (const ef of edgeFert) {
    const dup = logFert.some((lf) => Math.abs(lf.startMs - ef.startMs) < 5000 || Math.abs(lf.endMs - ef.endMs) < 5000);
    if (!dup) out.push({ ...ef, source: ef.source ?? "mqtt" });
  }
  return out;
}

export function registerPumpRunsRoutes(app) {
  app.get("/api/pump-runs", async (req, res) => {
    try {
      const now = Date.now();
      let from = Date.parse(String(req.query.from ?? ""));
      let to = Date.parse(String(req.query.to ?? ""));
      if (!Number.isFinite(from)) from = now - 6 * 3600_000;
      if (!Number.isFinite(to)) to = now;
      if (to < from) [from, to] = [to, from];

      /** @type {any[]} */
      let intervals = [];
      for (const r of closed) {
        if (r.end < from || r.start > to) continue;
        intervals.push({
          pump: r.pump,
          start: new Date(r.start).toISOString(),
          end: new Date(r.end).toISOString(),
          startMs: r.start,
          endMs: r.end,
          duration_s: Math.max(0, (r.end - r.start) / 1000),
        });
      }
      for (const [pump, start] of Object.entries(openAt)) {
        if (!start || start > to) continue;
        if (now < from) continue;
        intervals.push({
          pump,
          start: new Date(start).toISOString(),
          end: null,
          startMs: start,
          endMs: now,
          duration_s: Math.max(0, (now - start) / 1000),
          open: true,
        });
      }
      try {
        const logFert = await fertIntervalsFromLog(from, to);
        intervals = mergeFertLog(intervals, logFert);
      } catch (e) {
        console.warn("[pumpruns] fert log merge", e.message);
      }
      intervals.sort((a, b) => a.startMs - b.startMs);
      res.json({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        pumps: PUMPS,
        intervals,
        counts: Object.fromEntries(PUMPS.map((p) => [p.id, intervals.filter((i) => i.pump === p.id).length])),
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
}
