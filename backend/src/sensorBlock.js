// SensorBlock faceplate: MQTT Sensors/<dev> + CommandAck/<dev>, komentoihin Commands/<dev>.
// Laitelista: myko_settings k='sensorblock' { devices: string[] }. Oletus SensorBlock_1..3.
// Schema>=4 tukee komentoja; ack ilman correlation-id:ä (yksi pending / laite, ~5 s timeout).
import mqtt from "mqtt";
import { query } from "./db.js";

const SETTINGS_KEY = "sensorblock";
const DEFAULT_DEVICES = ["SensorBlock_1", "SensorBlock_2", "SensorBlock_3"];
const ACK_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 768;
const MAX_OVERRIDES = 16;
const CMD_SCHEMA_MIN = 4;

export const ERROR_CODES = {
  [-127]: "Missing",
  [-126]: "ReadError",
  [-125]: "Timeout",
  [-124]: "OutOfRange",
  [-123]: "NotReady",
  [-122]: "Disabled",
  [-121]: "Stale",
  [-120]: "InvalidConfig",
  [-119]: "AmbiguousId",
};

export const FIELD_UNITS = {
  AhtTemp1: "°C",
  AhtHum1: "%RH",
  DStemp1: "°C",
  DStemp2: "°C",
  DStemp3: "°C",
  DStemp4: "°C",
  DStemp5: "°C",
  DStemp6: "°C",
  DStemp7: "°C",
  DStemp8: "°C",
  Tds: "",
  Tds25: "",
  PH: "",
  PHr: "",
  kPa: "kPa",
  RSSI: "dBm",
  Uptime: "min",
  FanRequestedPercent: "%",
  FanDutyPercent: "%",
  FanPWM: "",
};

export const SENSOR_TEST_KEYS = new Set([
  "AhtTemp1",
  "AhtHum1",
  "DStemp1",
  "DStemp2",
  "DStemp3",
  "DStemp4",
  "DStemp5",
  "DStemp6",
  "DStemp7",
  "DStemp8",
  "Tds",
  "Tds25",
  "PH",
  "PHr",
  "kPa",
]);

export const CONTROL_WORD_BITS = [
  { bit: 0, name: "Aht" },
  { bit: 1, name: "Dallas" },
  { bit: 2, name: "Tds" },
  { bit: 3, name: "Ph" },
  { bit: 4, name: "Heating" },
  { bit: 5, name: "Fan" },
];

const META_KEYS = new Set([
  "ControlWord",
  "ConfigCached",
  "TestMode",
  "Heat",
  "HeatRequested",
  "FanRequestedPercent",
  "FanDutyPercent",
  "FanPWM",
  "Schema",
  "Status",
  "SensorTests",
  "at",
  "receivedAt",
]);

/** Decode sensor value: error code → status text; RSSI never treated as error. */
export function decodeSensorValue(key, raw) {
  if (raw === null || raw === undefined) return { kind: "empty", text: "—" };
  if (typeof raw === "boolean") return { kind: "bool", value: raw, text: raw ? "ON" : "OFF" };
  if (typeof raw === "string") return { kind: "text", value: raw, text: raw };
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { kind: "empty", text: "—" };
  if (key !== "RSSI" && Object.prototype.hasOwnProperty.call(ERROR_CODES, raw)) {
    return { kind: "error", code: raw, text: ERROR_CODES[raw], disabled: raw === -122 };
  }
  const unit = FIELD_UNITS[key] ?? "";
  return { kind: "value", value: raw, unit, text: unit ? `${raw} ${unit}` : String(raw) };
}

export function controlWordFlags(cw) {
  const n = Number(cw);
  if (!Number.isFinite(n)) return [];
  return CONTROL_WORD_BITS.map(({ bit, name }) => ({ name, bit, on: Boolean(n & (1 << bit)) }));
}

/** Validate + normalize POST body for Commands/<dev>. Returns { ok, payload } or { ok:false, error }. */
export function validateCommandBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_json" };
  }
  const out = {};
  let fields = 0;

  if (body.sensorTestsClear === true) {
    out.sensorTestsClear = true;
    fields++;
  }

  if (body.FanDutyPercent !== undefined) {
    const n = Number(body.FanDutyPercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: "outputs" };
    out.FanDutyPercent = Math.round(n);
    fields++;
  }

  if (body.sensorTests !== undefined) {
    const st = body.sensorTests;
    if (st == null || typeof st !== "object" || Array.isArray(st)) {
      return { ok: false, error: "sensor_tests" };
    }
    const cleaned = {};
    let overrides = 0;
    for (const [k, v] of Object.entries(st)) {
      if (!SENSOR_TEST_KEYS.has(k)) return { ok: false, error: "sensor_tests" };
      if (v === null) {
        cleaned[k] = null;
        overrides++;
      } else if (typeof v === "object" && v !== null && !Array.isArray(v) && "value" in v) {
        const n = Number(v.value);
        if (!Number.isFinite(n)) return { ok: false, error: "sensor_tests" };
        cleaned[k] = { value: n };
        overrides++;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        cleaned[k] = { value: v };
        overrides++;
      } else if (typeof v === "object" && v !== null && v.mode === "fixed" && Number.isFinite(Number(v.value))) {
        cleaned[k] = { mode: "fixed", value: Number(v.value) };
        overrides++;
      } else {
        return { ok: false, error: "sensor_tests" };
      }
      if (overrides > MAX_OVERRIDES) return { ok: false, error: "sensor_tests" };
    }
    out.sensorTests = cleaned;
    fields++;
  }

  if (!fields) return { ok: false, error: "no_fields" };

  const json = JSON.stringify(out);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: "invalid_json" };
  }
  return { ok: true, payload: out, json };
}

function normalizeDevices(list) {
  const raw = Array.isArray(list) ? list : DEFAULT_DEVICES;
  const out = [];
  const seen = new Set();
  for (const d of raw) {
    const name = String(d ?? "").trim();
    if (!name || seen.has(name)) continue;
    if (!/^[A-Za-z0-9_./-]{1,64}$/.test(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.length ? out : [...DEFAULT_DEVICES];
}

async function loadCfg() {
  try {
    const [r] = await query("SELECT v FROM myko_settings WHERE k = ?", [SETTINGS_KEY]);
    let c = {};
    try {
      c = r ? (typeof r.v === "string" ? JSON.parse(r.v) : (r.v ?? {})) : {};
    } catch {
      c = {};
    }
    return { devices: normalizeDevices(c.devices) };
  } catch {
    return { devices: [...DEFAULT_DEVICES] };
  }
}

async function saveCfg(next) {
  await query(
    "INSERT INTO myko_settings (k, v, updated_by) VALUES (?, ?, 'ui') ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)",
    [SETTINGS_KEY, JSON.stringify(next)],
  );
}

let MQ = null;
let devices = [...DEFAULT_DEVICES];
/** @type {Map<string, { values: Record<string, unknown>, at: number }>} */
const latest = new Map();
/** @type {Map<string, { resolve: (a: unknown) => void, timer: NodeJS.Timeout }>} */
const pending = new Map();

function topicsFor(devs) {
  const t = [];
  for (const d of devs) {
    t.push(`Sensors/${d}`, `CommandAck/${d}`);
  }
  return t;
}

function resubscribe() {
  if (!MQ?.connected) return;
  MQ.subscribe(topicsFor(devices), { qos: 0 }, (err) => {
    if (err) console.error("[sensorblock] subscribe", err.message);
  });
}

function deviceFromTopic(topic, prefix) {
  if (!topic.startsWith(prefix)) return null;
  const rest = topic.slice(prefix.length);
  return rest || null;
}

function enrich(dev, entry) {
  if (!entry) {
    return {
      device: dev,
      at: null,
      ageMs: null,
      stale: true,
      values: null,
      schema: null,
      commandsSupported: false,
      controlWord: [],
      sensorTests: [],
      testMode: false,
      decoded: {},
    };
  }
  const v = entry.values ?? {};
  const schema = typeof v.Schema === "number" ? v.Schema : null;
  const ageMs = Date.now() - entry.at;
  const sensorTests = Array.isArray(v.SensorTests) ? v.SensorTests : [];
  const decoded = {};
  for (const [k, raw] of Object.entries(v)) {
    if (META_KEYS.has(k) && k !== "FanRequestedPercent" && k !== "FanDutyPercent" && k !== "FanPWM") continue;
    decoded[k] = decodeSensorValue(k, raw);
  }
  // Always decode primary sensor-ish keys present
  for (const k of Object.keys(v)) {
    if (!(k in decoded) && !["SensorTests"].includes(k)) {
      if (typeof v[k] === "number" || typeof v[k] === "boolean" || typeof v[k] === "string") {
        decoded[k] = decodeSensorValue(k, v[k]);
      }
    }
  }
  return {
    device: dev,
    at: new Date(entry.at).toISOString(),
    ageMs,
    stale: ageMs > 60_000,
    values: v,
    schema,
    commandsSupported: schema != null && schema >= CMD_SCHEMA_MIN,
    controlWord: controlWordFlags(v.ControlWord),
    sensorTests,
    testMode: Boolean(v.TestMode) || sensorTests.length > 0,
    decoded,
    heat: v.Heat,
    heatRequested: v.HeatRequested,
    fanRequestedPercent: v.FanRequestedPercent,
    fanDutyPercent: v.FanDutyPercent,
    fanPwm: v.FanPWM,
    status: v.Status,
    rssi: v.RSSI,
    uptime: v.Uptime,
  };
}

export function startSensorBlock({ mqttUrl }) {
  const mq = mqtt.connect(mqttUrl, {
    clientId: `myko-backend-sb-${process.pid}`,
    reconnectPeriod: 5000,
  });
  MQ = mq;
  void loadCfg().then((c) => {
    devices = c.devices;
    if (mq.connected) resubscribe();
  });
  mq.on("connect", () => {
    console.log("[sensorblock] mqtt connected");
    resubscribe();
  });
  mq.on("message", (topic, buf) => {
    try {
      const text = buf.toString();
      const j = JSON.parse(text);
      const sens = deviceFromTopic(topic, "Sensors/");
      if (sens && devices.includes(sens)) {
        latest.set(sens, { values: j, at: Date.now() });
        return;
      }
      const ackDev = deviceFromTopic(topic, "CommandAck/");
      if (ackDev && pending.has(ackDev)) {
        const p = pending.get(ackDev);
        clearTimeout(p.timer);
        pending.delete(ackDev);
        p.resolve(j);
      }
    } catch {
      /* ignore bad payloads */
    }
  });
  mq.on("error", (e) => console.error("[sensorblock] mqtt", e.message));
}

async function ensureDevice(dev) {
  const cfg = await loadCfg();
  devices = cfg.devices;
  return devices.includes(dev);
}

export function registerSensorBlockRoutes(app) {
  app.get("/api/sensorblock", async (_req, res) => {
    try {
      const cfg = await loadCfg();
      devices = cfg.devices;
      res.json({
        devices: cfg.devices,
        items: cfg.devices.map((d) => enrich(d, latest.get(d))),
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.get("/api/sensorblock/config", async (_req, res) => {
    try {
      const cfg = await loadCfg();
      res.json(cfg);
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.put("/api/sensorblock/config", async (req, res) => {
    try {
      const next = { devices: normalizeDevices(req.body?.devices) };
      await saveCfg(next);
      const prev = new Set(devices);
      devices = next.devices;
      if (MQ?.connected) {
        const drop = [...prev].filter((d) => !devices.includes(d));
        if (drop.length) MQ.unsubscribe(topicsFor(drop));
        resubscribe();
      }
      res.json(next);
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.get("/api/sensorblock/:dev", async (req, res) => {
    try {
      const dev = String(req.params.dev ?? "");
      if (!(await ensureDevice(dev))) return res.status(404).json({ error: "unknown_device" });
      res.json(enrich(dev, latest.get(dev)));
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.post("/api/sensorblock/:dev/command", async (req, res) => {
    try {
      const dev = String(req.params.dev ?? "");
      if (!(await ensureDevice(dev))) return res.status(404).json({ error: "unknown_device" });
      const entry = latest.get(dev);
      const schema = entry?.values?.Schema;
      if (!(typeof schema === "number" && schema >= CMD_SCHEMA_MIN)) {
        return res.status(403).json({ error: "ei tue komentoja", schema: schema ?? null });
      }
      const v = validateCommandBody(req.body);
      if (!v.ok) return res.status(400).json({ error: v.error });
      if (!MQ?.connected) return res.status(503).json({ error: "MQTT ei yhteydessä" });
      if (pending.has(dev)) return res.status(409).json({ error: "komento jo käynnissä" });

      const ack = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(dev);
          resolve(null);
        }, ACK_TIMEOUT_MS);
        pending.set(dev, { resolve, timer });
        MQ.publish(`Commands/${dev}`, v.json, { qos: 1 }, (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(dev);
            resolve({ ok: false, error: String(err.message ?? err) });
          }
        });
      });

      if (!ack) return res.status(504).json({ error: "timeout", timeoutMs: ACK_TIMEOUT_MS });
      if (ack.ok === false) return res.status(502).json({ ok: false, error: ack.error ?? "ack_failed", ack });
      res.json({ ok: true, ack });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
}

/** Test helpers: inject latest telemetry without MQTT. */
export function _testSetLatest(dev, values) {
  latest.set(dev, { values, at: Date.now() });
}
export function _testClear() {
  latest.clear();
  for (const [, p] of pending) clearTimeout(p.timer);
  pending.clear();
}
export function _testSetDevices(list) {
  devices = normalizeDevices(list);
}
