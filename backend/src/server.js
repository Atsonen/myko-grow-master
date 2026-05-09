import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { query } from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3010);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5199";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    await query("SELECT 1 AS ok");
    res.json({ ok: true, db: true, service: "myko-valvomo-backend" });
  } catch (error) {
    res.status(500).json({ ok: false, db: false, error: error.message });
  }
});

app.get("/api/environment/latest", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 500);
  const rows = await query(
    `SELECT r.*
     FROM environment_readings r
     JOIN (
       SELECT location, MAX(timestamp) AS max_timestamp
       FROM environment_readings
       WHERE archived = 0
       GROUP BY location
     ) latest ON latest.location = r.location AND latest.max_timestamp = r.timestamp
     WHERE r.archived = 0
     ORDER BY r.location
     LIMIT ?`,
    [limit],
  );
  res.json(rows.map(mapReading));
});

app.get("/api/environment/readings", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 2000);
  const location = req.query.location ? String(req.query.location).toUpperCase() : null;
  const params = [];
  let where = "WHERE archived = 0";
  if (location) {
    where += " AND location = ?";
    params.push(location);
  }
  params.push(limit);
  const rows = await query(
    `SELECT * FROM environment_readings ${where} ORDER BY timestamp DESC LIMIT ?`,
    params,
  );
  res.json(rows.map(mapReading));
});

app.post("/api/environment/readings", async (req, res) => {
  const body = req.body ?? {};
  const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();
  if (!body.location) return res.status(400).json({ error: "location is required" });
  if (!Number.isFinite(Number(body.temperatureC)) && !Number.isFinite(Number(body.humidityRh)) && !Number.isFinite(Number(body.co2Ppm))) {
    return res.status(400).json({ error: "at least one metric is required" });
  }

  const result = await query(
    `INSERT INTO environment_readings
      (timestamp, location, source, mqtt_topic, payload_key, alias, temperature_c, humidity_rh, co2_ppm, raw_payload, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toMariaDbDateTime(timestamp),
      String(body.location).toUpperCase(),
      body.source ?? "api/manual",
      body.mqttTopic ?? null,
      body.payloadKey ?? null,
      body.alias ?? null,
      Number.isFinite(Number(body.temperatureC)) ? Number(body.temperatureC) : null,
      Number.isFinite(Number(body.humidityRh)) ? Number(body.humidityRh) : null,
      Number.isFinite(Number(body.co2Ppm)) ? Number(body.co2Ppm) : null,
      body.rawPayload ? JSON.stringify(body.rawPayload) : null,
      body.note ?? null,
    ],
  );
  res.status(201).json({ id: Number(result.insertId) });
});

app.get("/api/unit-locations", async (req, res) => {
  const unitCode = req.query.unitCode ? String(req.query.unitCode) : null;
  const params = [];
  let where = "WHERE archived = 0";
  if (unitCode) {
    where += " AND unit_code = ?";
    params.push(unitCode);
  }
  const rows = await query(`SELECT * FROM unit_locations ${where} ORDER BY moved_at DESC`, params);
  res.json(rows.map(mapUnitLocation));
});

app.post("/api/unit-locations", async (req, res) => {
  const body = req.body ?? {};
  if (!body.unitCode || !body.location) return res.status(400).json({ error: "unitCode and location are required" });
  const movedAt = body.movedAt ? new Date(body.movedAt) : new Date();
  const result = await query(
    `INSERT INTO unit_locations (unit_code, location, moved_at, note)
     VALUES (?, ?, ?, ?)`,
    [String(body.unitCode), String(body.location).toUpperCase(), toMariaDbDateTime(movedAt), body.note ?? null],
  );
  res.status(201).json({ id: Number(result.insertId) });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Myko backend listening on http://0.0.0.0:${PORT}`);
});

function mapReading(row) {
  return {
    id: Number(row.id),
    timestamp: new Date(row.timestamp).toISOString(),
    location: row.location,
    source: row.source,
    mqttTopic: row.mqtt_topic,
    payloadKey: row.payload_key,
    alias: row.alias,
    temperatureC: row.temperature_c === null ? undefined : Number(row.temperature_c),
    humidityRh: row.humidity_rh === null ? undefined : Number(row.humidity_rh),
    co2Ppm: row.co2_ppm === null ? undefined : Number(row.co2_ppm),
    note: row.note ?? undefined,
    archived: Boolean(row.archived),
  };
}

function mapUnitLocation(row) {
  return {
    id: Number(row.id),
    unitCode: row.unit_code,
    location: row.location,
    movedAt: new Date(row.moved_at).toISOString(),
    note: row.note ?? undefined,
    archived: Boolean(row.archived),
  };
}

function toMariaDbDateTime(date) {
  return date.toISOString().slice(0, 23).replace("T", " ");
}
