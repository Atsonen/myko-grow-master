import mqtt from "mqtt";
import dotenv from "dotenv";
import { closeDb, query } from "./db.js";

dotenv.config();

const MQTT_URL = process.env.MQTT_URL || "mqtt://192.168.1.51:1883";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "Sensors/SensorBlock_1";
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || "myko-valvomo-logger";
const SOURCE_ID = "src-sensorblock-1";

let channelCache = [];

const client = mqtt.connect(MQTT_URL, {
  clientId: MQTT_CLIENT_ID,
  clean: true,
  reconnectPeriod: 5000,
});

client.on("connect", async () => {
  console.log(`[mqtt] connected ${MQTT_URL}`);
  channelCache = await loadChannels();
  console.log(`[mqtt] loaded ${channelCache.length} channel mapping(s)`);
  client.subscribe(MQTT_TOPIC, { qos: 0 }, (error) => {
    if (error) console.error("[mqtt] subscribe error", error);
    else console.log(`[mqtt] subscribed ${MQTT_TOPIC}`);
  });
});

client.on("reconnect", () => console.log("[mqtt] reconnecting..."));
client.on("error", (error) => console.error("[mqtt] error", error.message));

client.on("message", async (topic, payloadBuffer) => {
  const receivedAt = new Date();
  const payloadText = payloadBuffer.toString("utf8");

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    console.warn(`[mqtt] invalid JSON on ${topic}: ${payloadText}`);
    return;
  }

  try {
    if (channelCache.length === 0) channelCache = await loadChannels();
    const inserted = await insertSensorBlockReadings(topic, payload, receivedAt, channelCache);
    if (inserted > 0) console.log(`[mqtt] inserted ${inserted} reading(s) ${receivedAt.toISOString()}`);
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
    [SOURCE_ID],
  );
  return rows.map((row) => ({
    payloadKey: row.payload_key,
    alias: row.alias,
    location: row.location,
    metric: row.metric,
  }));
}

async function insertSensorBlockReadings(topic, payload, timestamp, channels) {
  let inserted = 0;
  const timestampSql = toMariaDbDateTime(timestamp);

  for (const channel of channels) {
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
        null,
      ],
    );
    inserted += 1;
  }

  return inserted;
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
