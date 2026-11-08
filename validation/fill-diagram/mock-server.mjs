// Synthetic API for the process diagram. No MQTT, DB, PLC, or production files.
import http from "node:http";

const ISO = "2026-11-08T08:25:00.000Z";
const ALLOWED_GET = [
  /^\/api\/fillpump$/,
  /^\/api\/fillpump\/source$/,
  /^\/api\/pumput$/,
  /^\/api\/sequence$/,
  /^\/api\/fertdose$/,
  /^\/api\/kasvamo\/alarms$/,
  /^\/api\/light$/,
  /^\/api\/datalogger\/latest$/,
  /^\/api\/dashboard\/layout$/,
  /^\/api\/pid\/G_Air$/,
  /^\/api\/pid\/G_Air\/feed$/,
  /^\/api\/pid\/G_Air\/ai-analysis$/,
  /^\/api\/alarms\/points$/,
  /^\/api\/pump-runs$/,
  /^\/api\/state$/,
  /^\/api\/environment\/latest$/,
  /^\/api\/trends\/variables$/,
];

export const requests = [];
let scenario = "fault";

const plcKeys = /^(Run|Cmd_Ack|Pump|St_|Cfg_)/;

function sourceBody() {
  const common = {
    ok: true,
    label: "Suuntaa-antava arvio · ei mittaus",
    plcWrite: false,
    partialRefill: false,
    fullRefillOnly: true,
    meaning: "accumulated-pump-output-seconds",
    persisted: true,
    zeroIsNotMeasuredEmpty: false,
  };
  if (scenario === "fault") {
    return { ...common, available: false, referenceS: 1320, accumulatedS: 0, remainingRatio: null, remainingCoarsePct: null, quality: "unknown", qualityNote: "Ei ankkuria.", anchor: null, refLog: [], persisted: false };
  }
  const refLog1320 = [{ atMs: Date.parse(ISO), at: ISO, oldS: 1200, newS: 1320, by: "synteettinen" }];
  if (scenario === "run50") {
    return { ...common, available: true, referenceS: 1320, accumulatedS: 660, remainingRatio: 0.5, remainingCoarsePct: 50, quality: "ok", qualityNote: "Tuore MQTT-tila. Synteettinen.", anchor: { id: "syn-1", atMs: Date.parse("2026-11-08T06:25:00.000Z"), at: "2026-11-08T06:25:00.000Z", by: "synteettinen" }, refLog: refLog1320 };
  }
  const refLog2640 = [...refLog1320, { atMs: Date.parse(ISO), at: ISO, oldS: 1320, newS: 2640, by: "synteettinen" }];
  if (scenario === "ref2640") {
    return { ...common, available: true, referenceS: 2640, accumulatedS: 660, remainingRatio: 0.75, remainingCoarsePct: 80, quality: "ok", qualityNote: "Viite vaihdettu. Kertymä säilyi.", anchor: { id: "syn-1", atMs: Date.parse("2026-11-08T06:25:00.000Z"), at: "2026-11-08T06:25:00.000Z", by: "synteettinen" }, refLog: refLog2640 };
  }
  return { ...common, available: true, referenceS: 2640, accumulatedS: 0, remainingRatio: 1, remainingCoarsePct: 100, quality: "ok", qualityNote: "Säiliö merkitty täydeksi. Synteettinen.", anchor: { id: "syn-2", atMs: Date.parse(ISO), at: ISO, by: "synteettinen" }, refLog: refLog2640 };
}

function fillPump() {
  const fault = scenario === "fault";
  return {
    present: !fault,
    stale: fault,
    write_allowed: true,
    write_note: "synthetic",
    plc_at: ISO,
    err_codes: { "1": "maksimitäyttöaika" },
    allowed_writes: ["Cfg_Enable", "Cfg_LvlSP", "Cfg_Hyst", "Cfg_MaxRun_s", "Cmd_Ack"],
    alarms: fault ? { active: { err_1: true }, texts: { err_1: "synteettinen vika" } } : { active: {}, texts: {} },
    events: [{ ts: ISO, kind: fault ? "alarm" : "cmd", text: "synteettinen tapahtuma" }],
    trend: [],
    plc: fault
      ? { Pump: true, St_Running: true, Run: true, St_Error: true, St_ErrCode: 1, Cfg_Enable: true, Cfg_LvlSP: 40, Cfg_Hyst: 5, Cfg_MaxRun_s: 300, Level: 42 }
      : { Pump: true, St_Running: true, Run: false, St_Error: false, St_ErrCode: 0, Cfg_Enable: true, Cfg_LvlSP: 40, Cfg_Hyst: 5, Cfg_MaxRun_s: 300, Level: 48 },
  };
}

function json(res, code, body) {
  const raw = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export function startMock(port = 5197) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try { body = await readBody(req); } catch { body = { parseError: true }; }
    }
    const entry = { at: new Date().toISOString(), method: req.method, path, query: url.search, body };
    requests.push(entry);
    if (path === "/__scenario" && req.method === "POST") {
      scenario = String(body?.scenario || scenario);
      return json(res, 200, { scenario });
    }
    if (path === "/__requests") return json(res, 200, { scenario, requests });
    if (req.method === "GET" && ALLOWED_GET.some((re) => re.test(path))) {
      if (path === "/api/fillpump") return json(res, 200, fillPump());
      if (path === "/api/fillpump/source") return json(res, 200, sourceBody());
      if (path === "/api/datalogger/latest") {
        const keys = (url.searchParams.get("keys") || "").split(",").filter(Boolean);
        return json(res, 200, keys.map((variableKey) => ({ variableKey, raw: 1, value: variableKey === "dl25" ? 55 : 21, timestamp: ISO })));
      }
      if (path === "/api/pumput") return json(res, 200, { at: ISO, stale: false, values: { Level: 55, LVL: 54 } });
      if (path === "/api/sequence") {
        return json(res, 200, {
          settings: { enable: false, t_circ_s: 60, t_settle_s: 20, plc_write: false, hb_enabled: false },
          present: true, stale: false, plc_at: ISO, steps: { "0": "Seis" },
          write_allowed: false, write_note: "synthetic", pump_write_allowed: false, seq_enable_write_allowed: false,
          plc: { present: true, Step: 0, Enable: false, Stopped: true, HB_OK: true, LeakAlarm: false, TankLevel: 55, LvlSnap: 54, L_Enable: true, R_Enable: true, L_Pump: false, R_Pump: false, L_Running: false, R_Running: false, L_Error: false, R_Error: false },
        });
      }
      if (path === "/api/fertdose") {
        return json(res, 200, {
          mode: "off", heartbeat: "off", hbValue: 0, interlock: true, pump_write_allowed: false,
          config: { live: false, hb_enabled: false, plc_enable: false, auto: false, fert: "A", dose_s: 1, below_min: 0, pause_min: 1, ec_alarm: { enabled: false, lo_off: 0, hi_off: 0, warn_lo_off: 0, warn_hi_off: 0, hyst: 0, delay_min: 0 } },
          plc: { present: false, fresh: false, statusText: null, Pump: false, Enable: false },
          ec: null, sp: null, belowSince: null, lastDoseAt: null, nextAllowedAt: null, reason: "", active: [], events: [], cumulative: [], recent: [],
        });
      }
      if (path === "/api/kasvamo/alarms") return json(res, 200, { config: { enabled: false, delay_min: 0, stale_min: 0, limits: {} }, active: {}, signals: {} });
      if (path === "/api/light") return json(res, 200, { groups: [], config: {}, write_note: "synthetic", allowed_writes: [], mapping_pending: true, stale_ms: 30000, startup_grace_s: 0 });
      if (path === "/api/dashboard/layout") return json(res, 200, { id: url.searchParams.get("id"), layout: null, updatedAt: null });
      if (path === "/api/pid/G_Air") return json(res, 200, { at: ISO, values: {}, active: [], trend: [] });
      if (path === "/api/pid/G_Air/feed") return json(res, 200, { key: "G_Air", feed: { topic: null, field: null, enabled: false }, sources: [] });
      if (path === "/api/pid/G_Air/ai-analysis") return json(res, 200, { key: "G_Air", hasNew: false, analyses: [], history: [], canRestore: false, limits: {}, maxRelChange: 0, rateMin: 0 });
      if (path === "/api/alarms/points") return json(res, 200, []);
      if (path === "/api/pump-runs") return json(res, 200, { from: url.searchParams.get("from"), to: url.searchParams.get("to"), pumps: [], intervals: [], counts: {} });
      if (path === "/api/state") return json(res, 200, { units: [], events: [], strains: [], transfers: [] });
      if (path === "/api/environment/latest") return json(res, 200, []);
      if (path === "/api/trends/variables") return json(res, 200, []);
    }
    if (req.method === "POST" && path === "/api/fillpump/source/reference") {
      const keys = Object.keys(body || {});
      const bad = keys.filter((k) => !["confirm", "by", "idempotencyKey", "referenceS"].includes(k) || plcKeys.test(k));
      if (bad.length || body?.referenceS !== 2640) return json(res, 400, { error: "synthetic reference rejected", bad });
      scenario = "ref2640";
      return json(res, 200, { ok: true, duplicate: false, referenceS: 2640, ...sourceBody() });
    }
    if (req.method === "POST" && path === "/api/fillpump/source/refill") {
      const keys = Object.keys(body || {});
      const bad = keys.filter((k) => !["confirm", "by", "idempotencyKey"].includes(k) || plcKeys.test(k));
      if (bad.length) return json(res, 400, { error: "synthetic refill rejected", bad });
      scenario = "refilled";
      return json(res, 200, { ok: true, duplicate: false, anchorId: "syn-2", ...sourceBody() });
    }
    entry.rejected = true;
    json(res, 599, { error: "synthetic mock rejected this request", method: req.method, path });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock().then(() => console.log("synthetic api 127.0.0.1:5197"));
}
