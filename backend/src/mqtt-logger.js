import mqtt from "mqtt";
import dotenv from "dotenv";
import { closeDb, query, withConnection } from "./db.js";

dotenv.config();

const MQTT_URL = process.env.MQTT_URL || "mqtt://192.168.1.51:1883";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "Sensors/SensorBlock_1";
const MQTT_DATALOGGER_TOPIC = process.env.MQTT_DATALOGGER_TOPIC || "Datalogger/";
const MQTT_TOPICS = unique([
  ...splitTopics(process.env.MQTT_TOPICS),
  MQTT_TOPIC,
  MQTT_DATALOGGER_TOPIC,
  ...topicSlashVariants(MQTT_DATALOGGER_TOPIC),
]);
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || "myko-valvomo-logger";
const SENSORBLOCK_SOURCE_ID = "src-sensorblock-1";
const DATALOGGER_SOURCE_ID = "src-datalogger";
const LOG_INTERVAL_SECONDS = Number(process.env.ENV_LOG_INTERVAL_SECONDS || 60);
const LOG_INTERVAL_MS = Math.max(1, LOG_INTERVAL_SECONDS) * 1000;
const DATALOGGER_LOG_INTERVAL_SECONDS = Number(process.env.DATALOGGER_LOG_INTERVAL_SECONDS || 60);
const DATALOGGER_LOG_INTERVAL_MS = Math.max(0, DATALOGGER_LOG_INTERVAL_SECONDS) * 1000;
// Publishers send on (about) the same period as the log interval, so a message arriving a few ms
// early must not be dropped (that lost ~1 minute in 4). Accept when elapsed >= interval - tolerance.
const THROTTLE_TOLERANCE_MS = Number(process.env.LOG_INTERVAL_TOLERANCE_SECONDS || 5) * 1000;
const tol = (intervalMs) => Math.max(0, intervalMs - Math.min(THROTTLE_TOLERANCE_MS, intervalMs / 2));
const ENV_MIN_ELAPSED_MS = tol(LOG_INTERVAL_MS);
const DATALOGGER_MIN_ELAPSED_MS = tol(DATALOGGER_LOG_INTERVAL_MS);

let channelCache = [];
let dataloggerVariableCache = [];
const lastSavedAtByChannel = new Map();
let lastDataloggerSavedAt = 0;

const client = mqtt.connect(MQTT_URL, {
  clientId: MQTT_CLIENT_ID,
  clean: true,
  reconnectPeriod: 5000,
});

client.on("connect", async () => {
  console.log(`[mqtt] connected ${MQTT_URL}`);
  console.log(`[mqtt] log interval ${LOG_INTERVAL_SECONDS}s/channel`);
  console.log(`[mqtt] datalogger interval ${DATALOGGER_LOG_INTERVAL_SECONDS}s/sample`);
  channelCache = await loadChannels();
  dataloggerVariableCache = await loadDataloggerVariables();
  lastDataloggerSavedAt = await loadLastDataloggerSavedAt();
  console.log(`[mqtt] loaded ${channelCache.length} channel mapping(s)`);
  console.log(`[mqtt] loaded ${dataloggerVariableCache.length} datalogger variable(s)`);
  client.subscribe(MQTT_TOPICS, { qos: 0 }, (error) => {
    if (error) console.error("[mqtt] subscribe error", error);
    else console.log(`[mqtt] subscribed ${MQTT_TOPICS.join(", ")}`);
  });
});

client.on("reconnect", () => console.log("[mqtt] reconnecting..."));
client.on("error", (error) => console.error("[mqtt] error", error.message));

client.on("message", async (topic, payloadBuffer) => {
  const receivedAt = new Date();
  const payloadText = payloadBuffer.toString("utf8");

  let payload = null;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    payload = payloadText;
  }

  try {
    if (channelCache.length === 0) channelCache = await loadChannels();
    if (dataloggerVariableCache.length === 0)
      dataloggerVariableCache = await loadDataloggerVariables();

    let inserted = 0;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      inserted += await insertSensorBlockReadings(topic, payload, receivedAt, channelCache);
    }

    const dataloggerValues = extractDataloggerValues(payload, payloadText);
    if (dataloggerValues.length > 0) {
      inserted += await insertDataloggerSample(
        topic,
        payload,
        payloadText,
        receivedAt,
        dataloggerValues,
        dataloggerVariableCache,
      );
    }

    if (inserted > 0)
      console.log(`[mqtt] inserted ${inserted} reading(s) ${receivedAt.toISOString()}`);
  } catch (error) {
    console.error("[mqtt] insert error", error);
  }
});

async function loadChannels() {
  const rows = await query(
    `SELECT payload_key, alias, location, metric
     FROM environment_channel_map
     WHERE source_id = ?
     ORDER BY payload_key`,
    [SENSORBLOCK_SOURCE_ID],
  );
  return rows.map((row) => ({
    payloadKey: row.payload_key,
    alias: row.alias,
    location: row.location,
    metric: row.metric,
  }));
}

async function loadDataloggerVariables() {
  const rows = await query(
    `SELECT position, variable_key, name, unit, scale, archived
     FROM datalogger_variables
     WHERE source_id = ?
     ORDER BY position`,
    [DATALOGGER_SOURCE_ID],
  );
  return rows.map((row) => ({
    position: Number(row.position),
    variableKey: row.variable_key,
    name: row.name,
    unit: row.unit,
    scale: Number(row.scale),
    archived: Boolean(row.archived),
  }));
}

async function loadLastDataloggerSavedAt() {
  const rows = await query(
    `SELECT MAX(timestamp) AS last_timestamp
     FROM datalogger_samples
     WHERE source_id = ?`,
    [DATALOGGER_SOURCE_ID],
  );
  const lastTimestamp = rows[0]?.last_timestamp;
  return lastTimestamp ? new Date(lastTimestamp).getTime() : 0;
}

async function insertSensorBlockReadings(topic, payload, timestamp, channels) {
  let inserted = 0;
  const timestampSql = toMariaDbDateTime(timestamp);

  for (const channel of channels) {
    const channelId = `${topic}/${channel.payloadKey}/${channel.metric}`;
    const lastSavedAt = lastSavedAtByChannel.get(channelId) ?? 0;
    if (timestamp.getTime() - lastSavedAt < ENV_MIN_ELAPSED_MS) continue;

    const raw = payload[channel.payloadKey];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) continue;

    await query(
      `INSERT INTO environment_readings
        (timestamp, location, source, mqtt_topic, payload_key, alias, temperature_c, humidity_rh, co2_ppm, raw_payload, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        timestampSql,
        channel.location,
        `SensorBlock 1/${channel.alias}/${channel.payloadKey}`,
        topic,
        channel.payloadKey,
        channel.alias,
        channel.metric === "temperatureC" ? value : null,
        channel.metric === "humidityRh" ? value : null,
        channel.metric === "co2Ppm" ? value : null,
        JSON.stringify(payload),
        `interval=${LOG_INTERVAL_SECONDS}s`,
      ],
    );
    lastSavedAtByChannel.set(channelId, timestamp.getTime());
    inserted += 1;
  }

  return inserted;
}

async function insertDataloggerSample(topic, payload, payloadText, timestamp, values, variables) {
  if (
    DATALOGGER_LOG_INTERVAL_MS > 0 &&
    timestamp.getTime() - lastDataloggerSavedAt < DATALOGGER_MIN_ELAPSED_MS
  ) {
    return 0;
  }

  const timestampSql = toMariaDbDateTime(timestamp);
  const rawPayload =
    typeof payload === "object" && payload !== null
      ? JSON.stringify(payload)
      : JSON.stringify({ Data: values });

  const inserted = await withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const sampleResult = await conn.query(
        `INSERT INTO datalogger_samples (timestamp, source_id, mqtt_topic, raw_payload, raw_text)
         VALUES (?, ?, ?, ?, ?)`,
        [timestampSql, DATALOGGER_SOURCE_ID, topic, rawPayload, payloadText],
      );
      const sampleId = Number(sampleResult.insertId);
      let count = 0;

      for (const [position, rawValue] of values.entries()) {
        const variable =
          variables.find((item) => item.position === position) ?? fallbackVariable(position);
        const numericValue = rawValue * variable.scale;
        await conn.query(
          `INSERT INTO datalogger_values
             (sample_id, timestamp, source_id, position, variable_key, variable_name, raw_value, numeric_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sampleId,
            timestampSql,
            DATALOGGER_SOURCE_ID,
            position,
            variable.variableKey,
            variable.name,
            rawValue,
            numericValue,
          ],
        );
        count += 1;
      }

      await conn.commit();
      return count;
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  });

  lastDataloggerSavedAt = timestamp.getTime();
  return inserted;
}

function extractDataloggerValues(payload, payloadText) {
  if (Array.isArray(payload)) return numericArray(payload);

  if (payload && typeof payload === "object") {
    for (const key of ["Datalogger", "Data", "data", "values", "Values"]) {
      if (key in payload) {
        const values = parseDataloggerValue(payload[key]);
        if (values.length > 0) return values;
      }
    }
  }

  return parseDataloggerText(payloadText);
}

function parseDataloggerValue(value) {
  if (Array.isArray(value)) return numericArray(value);
  if (typeof value === "string") return parseDataloggerText(value);
  return [];
}

function parseDataloggerText(text) {
  const source = String(text ?? "").trim();
  const match =
    source.match(/(?:Data|Datalogger)\s*:\s*\{([^}]+)\}/i) ?? source.match(/^\{([^}]+)\}$/);
  if (!match) return [];
  return numericArray(match[1].split(","));
}

function numericArray(values) {
  return values
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isFinite(value));
}

function fallbackVariable(position) {
  return {
    position,
    variableKey: `dl${String(position).padStart(2, "0")}`,
    name: `Datalogger ${position}`,
    scale: 1,
  };
}

function splitTopics(value) {
  return String(value || "")
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function topicSlashVariants(topic) {
  const normalized = String(topic || "").trim();
  if (!normalized) return [];
  return normalized.endsWith("/") ? [normalized.slice(0, -1)] : [`${normalized}/`];
}

function toMariaDbDateTime(date) {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

async function shutdown(signal) {
  console.log(`[mqtt] ${signal} received, shutting down...`);
  client.end(true);
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
