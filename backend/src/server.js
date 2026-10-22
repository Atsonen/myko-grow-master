import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import mqtt from "mqtt";
import { query, withConnection } from "./db.js";
import { normalizeOrigins, registerTraceRoutes, writeOrigins } from "./trace.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3010);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5199";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "50mb" }));

// Traceability routes are registered first so they take precedence (GET /api/units is enriched there).
registerTraceRoutes(app, { mapUnit, mapEvent, mapTransfer, mapUnitLocation, asyncRoute });

app.get(["/health", "/api/health"], async (_req, res) => {
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
    `SELECT r.*, DATE_FORMAT(r.timestamp, '%Y-%m-%dT%H:%i:%sZ') AS timestamp_iso
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
    `SELECT *, DATE_FORMAT(timestamp, '%Y-%m-%dT%H:%i:%sZ') AS timestamp_iso
     FROM environment_readings ${where} ORDER BY timestamp DESC LIMIT ?`,
    params,
  );
  res.json(rows.map(mapReading));
});

app.post("/api/environment/readings", async (req, res) => {
  const body = req.body ?? {};
  const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();
  if (!body.location) return res.status(400).json({ error: "location is required" });
  if (
    !Number.isFinite(Number(body.temperatureC)) &&
    !Number.isFinite(Number(body.humidityRh)) &&
    !Number.isFinite(Number(body.co2Ppm))
  ) {
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

// Moving a unit: append to unit_locations (history) AND keep units.current_location in sync
// with the latest history row, so every view agrees on where the unit is.
app.post(
  "/api/unit-locations",
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const unitCode = String(body.unitCode ?? "").trim();
    const location = String(body.location ?? "").trim().toUpperCase();
    if (!unitCode || !location)
      return res.status(400).json({ error: "unitCode and location are required" });
    const movedAt = body.movedAt ? new Date(body.movedAt) : new Date();
    if (Number.isNaN(movedAt.getTime())) return res.status(400).json({ error: "movedAt is invalid" });

    const result = await withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        await assertLookup(conn, "locations", location, "location");
        const units = await conn.query("SELECT code FROM units WHERE code = ? FOR UPDATE", [unitCode]);
        if (units.length === 0) {
          await conn.rollback();
          return null;
        }
        const insert = await conn.query(
          `INSERT INTO unit_locations (unit_code, location, moved_at, note) VALUES (?, ?, ?, ?)`,
          [unitCode, location, toMariaDbDateTime(movedAt), body.note ? String(body.note) : null],
        );
        await syncUnitCurrentLocation(conn, unitCode);
        const [row] = await conn.query("SELECT * FROM unit_locations WHERE id = ?", [insert.insertId]);
        await conn.commit();
        return mapUnitLocation(row);
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    });
    if (!result) return res.status(404).json({ error: `Unit ${unitCode} not found` });
    res.status(201).json(result);
  }),
);

// Undo a move (soft delete) and re-sync the unit's current location.
app.post(
  "/api/unit-locations/:id/archive",
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const result = await withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        const rows = await conn.query("SELECT unit_code FROM unit_locations WHERE id = ?", [id]);
        if (rows.length === 0) {
          await conn.rollback();
          return null;
        }
        await conn.query("UPDATE unit_locations SET archived = 1 WHERE id = ?", [id]);
        const current = await syncUnitCurrentLocation(conn, rows[0].unit_code);
        await conn.commit();
        return { ok: true, unitCode: rows[0].unit_code, currentLocation: current };
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    });
    if (!result) return res.status(404).json({ error: `Location record ${id} not found` });
    res.json(result);
  }),
);

async function syncUnitCurrentLocation(conn, unitCode) {
  const [latest] = await conn.query(
    `SELECT location FROM unit_locations WHERE unit_code = ? AND archived = 0
     ORDER BY moved_at DESC, id DESC LIMIT 1`,
    [unitCode],
  );
  const location = latest?.location ?? null;
  if (location !== null)
    // Keep updated_at: it is used as a fallback "ended at" time for finished units.
    await conn.query(
      "UPDATE units SET current_location = ?, updated_at = updated_at WHERE code = ?",
      [location, unitCode],
    );
  return location;
}

// Per-unit environment curve over the unit's lifetime, assembled from its location history.
// Each history period [moved_at, next moved_at) is joined to environment_readings of that
// location (readings are already tagged with location via environment_channel_map).
app.get(
  "/api/units/:code/environment",
  asyncRoute(async (req, res) => {
    const code = String(req.params.code);
    const maxPoints = Math.min(Math.max(Number(req.query.points) || 400, 20), 2000);
    const [unit] = await query("SELECT code, status, batch_time, updated_at, current_location FROM units WHERE code = ?", [code]);
    if (!unit) return res.status(404).json({ error: `Unit ${code} not found` });

    const start = new Date(unit.batch_time);
    const ended = ["ARCHIVED", "DISCARDED", "HARVESTED"].includes(String(unit.status));
    let end = new Date();
    if (ended) {
      // Prefer the event that ended the unit; then its latest event; then units.updated_at.
      const [ev] = await query(
        `SELECT MAX(CASE WHEN status_change IN ('ARCHIVED','DISCARDED','HARVESTED') THEN event_time END) AS ended_at,
                MAX(event_time) AS last_event
         FROM events WHERE unit_code = ? AND archived = 0`,
        [code],
      );
      const endedAt = ev?.ended_at ?? ev?.last_event ?? unit.updated_at;
      end = new Date(endedAt);
      if (end < start) end = new Date(unit.updated_at);
    }
    const history = await query(
      `SELECT id, location, moved_at, note FROM unit_locations
       WHERE unit_code = ? AND archived = 0 ORDER BY moved_at, id`,
      [code],
    );

    // Build periods. Before the first recorded move the location is unknown; if there is no
    // history at all, fall back to units.current_location for the whole lifetime.
    const periods = [];
    if (history.length === 0 && unit.current_location) {
      periods.push({ location: unit.current_location, from: start, to: end, assumed: true });
    }
    history.forEach((h, i) => {
      const from = new Date(Math.max(new Date(h.moved_at).getTime(), start.getTime()));
      const to = i + 1 < history.length ? new Date(history[i + 1].moved_at) : end;
      if (to > from) periods.push({ location: h.location, from, to, assumed: false });
    });

    const spanSeconds = Math.max((end.getTime() - start.getTime()) / 1000, 60);
    const bucketSeconds = Math.max(60, Math.ceil(spanSeconds / maxPoints));
    const points = [];
    for (const period of periods) {
      const rows = await query(
        `SET STATEMENT max_statement_time=5 FOR
         SELECT FLOOR(UNIX_TIMESTAMP(timestamp) / ?) AS bucket,
                AVG(CASE WHEN temperature_c > -100 THEN temperature_c END) AS t,
                MIN(CASE WHEN temperature_c > -100 THEN temperature_c END) AS tmin,
                MAX(CASE WHEN temperature_c > -100 THEN temperature_c END) AS tmax,
                AVG(CASE WHEN humidity_rh >= 0 AND humidity_rh <= 100 THEN humidity_rh END) AS rh
         FROM environment_readings
         WHERE location = ? AND timestamp >= ? AND timestamp < ? AND archived = 0
         GROUP BY bucket ORDER BY bucket`,
        [bucketSeconds, period.location, toMariaDbDateTime(period.from), toMariaDbDateTime(period.to)],
      );
      for (const r of rows) {
        if (r.t === null && r.rh === null) continue;
        points.push({
          timestamp: new Date(
            Math.max(Number(r.bucket) * bucketSeconds * 1000, period.from.getTime()),
          ).toISOString(),
          location: period.location,
          temperatureC: r.t === null ? null : Math.round(Number(r.t) * 100) / 100,
          temperatureMin: r.tmin === null ? null : Number(r.tmin),
          temperatureMax: r.tmax === null ? null : Number(r.tmax),
          humidityRh: r.rh === null ? null : Math.round(Number(r.rh) * 10) / 10,
        });
      }
    }

    res.json({
      unitCode: code,
      from: start.toISOString(),
      to: end.toISOString(),
      ended,
      bucketSeconds,
      periods: periods.map((p) => ({
        location: p.location,
        from: p.from.toISOString(),
        to: p.to.toISOString(),
        assumed: p.assumed,
      })),
      moves: history.map(mapUnitLocation),
      points,
    });
  }),
);

// Global per-variable trend series defaults (display name, color, axis), reused by every
// trend view; widgets may override. Stored as one row in dashboard_layouts.
const SERIES_DEFAULTS_ID = "__series_defaults";
function cleanSeriesStyles(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input).slice(0, 500)) {
    if (!v || typeof v !== "object") continue;
    const st = {};
    if (typeof v.name === "string" && v.name.trim()) st.name = v.name.trim().slice(0, 120);
    if (typeof v.color === "string" && /^#[0-9a-fA-F]{6}$/.test(v.color)) st.color = v.color.toLowerCase();
    if (v.axis === "left" || v.axis === "right") st.axis = v.axis;
    if (Object.keys(st).length) out[String(k).slice(0, 200)] = st;
  }
  return out;
}
app.get(
  "/api/trends/series-defaults",
  asyncRoute(async (_req, res) => {
    const [row] = await query("SELECT layout_json FROM dashboard_layouts WHERE id = ?", [SERIES_DEFAULTS_ID]);
    const j = row ? (typeof row.layout_json === "string" ? JSON.parse(row.layout_json) : row.layout_json) : {};
    res.json({ series: j?.series ?? {} });
  }),
);
app.put(
  "/api/trends/series-defaults",
  asyncRoute(async (req, res) => {
    const series = cleanSeriesStyles(req.body?.series);
    await query(
      `INSERT INTO dashboard_layouts (id, layout_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE layout_json = VALUES(layout_json)`,
      [SERIES_DEFAULTS_ID, JSON.stringify({ series })],
    );
    res.json({ series });
  }),
);

// Customizable dashboard layout (single user: one row with id "default").
// Body: { widgets: [{ id, type, title?, config?, x, y, w, h }] }. GET returns layout null
// when nothing is saved yet so the frontend can use its built-in default.
app.get(
  "/api/dashboard/layout",
  asyncRoute(async (req, res) => {
    const id = String(req.query.id || "default");
    const [row] = await query(
      "SELECT layout_json, DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_iso FROM dashboard_layouts WHERE id = ?",
      [id],
    );
    if (!row) return res.json({ id, layout: null, updatedAt: null });
    const layout = typeof row.layout_json === "string" ? JSON.parse(row.layout_json) : row.layout_json;
    res.json({ id, layout, updatedAt: row.updated_iso });
  }),
);

app.put(
  "/api/dashboard/layout",
  asyncRoute(async (req, res) => {
    const id = String(req.query.id || "default");
    const layout = req.body?.layout;
    if (!layout || !Array.isArray(layout.widgets))
      return res.status(400).json({ error: "layout.widgets must be an array" });
    if (layout.widgets.length > 60) return res.status(400).json({ error: "Too many widgets (max 60)" });
    const widgets = layout.widgets.map((w) => {
      if (!w || typeof w.id !== "string" || typeof w.type !== "string")
        throw Object.assign(new Error("Each widget needs string id and type"), { status: 400 });
      const n = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : d);
      return {
        id: w.id.slice(0, 80),
        type: w.type.slice(0, 40),
        title: typeof w.title === "string" ? w.title.slice(0, 160) : undefined,
        config: w.config && typeof w.config === "object" ? w.config : {},
        x: n(w.x, 0), y: n(w.y, 0), w: Math.max(1, n(w.w, 4)), h: Math.max(1, n(w.h, 4)),
      };
    });
    const json = JSON.stringify({ version: 1, widgets });
    if (json.length > 200_000) return res.status(400).json({ error: "Layout too large" });
    await query(
      `INSERT INTO dashboard_layouts (id, layout_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE layout_json = VALUES(layout_json)`,
      [id, json],
    );
    res.json({ id, layout: { version: 1, widgets } });
  }),
);

app.delete(
  "/api/dashboard/layout",
  asyncRoute(async (req, res) => {
    await query("DELETE FROM dashboard_layouts WHERE id = ?", [String(req.query.id || "default")]);
    res.json({ ok: true });
  }),
);

// /api/trends/variables: full stats (COUNT/AVG over ~10M rows) are slow, so they are
// computed in the background and cached. Requests are answered from the cache, or
// from a fast index-only metadata query until the first full computation finishes.
const TRENDS_STATS_REFRESH_MS = Number(process.env.TRENDS_STATS_REFRESH_SECONDS || 600) * 1000;
const TRENDS_STATS_MAX_SECONDS = Number(process.env.TRENDS_STATS_MAX_SECONDS || 900);
const TRENDS_FAST_MAX_SECONDS = Number(process.env.TRENDS_FAST_MAX_SECONDS || 5);
let trendStatsCache = null;
let trendStatsRefreshing = null;

const TRENDS_ENV_FULL_SQL = `SELECT
       metric,
       location,
       sample_count,
       DATE_FORMAT(min_timestamp, '%Y-%m-%dT%H:%i:%sZ') AS min_timestamp_iso,
       DATE_FORMAT(max_timestamp, '%Y-%m-%dT%H:%i:%sZ') AS max_timestamp_iso,
       min_value,
       max_value,
       avg_value
     FROM (
       SELECT
         'temperatureC' AS metric,
         location,
         COUNT(*) AS sample_count,
         MIN(timestamp) AS min_timestamp,
         MAX(timestamp) AS max_timestamp,
         MIN(temperature_c) AS min_value,
         MAX(temperature_c) AS max_value,
         AVG(temperature_c) AS avg_value
       FROM environment_readings
       WHERE archived = 0 AND temperature_c IS NOT NULL
       GROUP BY location
       UNION ALL
       SELECT
         'humidityRh' AS metric,
         location,
         COUNT(*) AS sample_count,
         MIN(timestamp) AS min_timestamp,
         MAX(timestamp) AS max_timestamp,
         MIN(humidity_rh) AS min_value,
         MAX(humidity_rh) AS max_value,
         AVG(humidity_rh) AS avg_value
       FROM environment_readings
       WHERE archived = 0 AND humidity_rh IS NOT NULL
       GROUP BY location
       UNION ALL
       SELECT
         'co2Ppm' AS metric,
         location,
         COUNT(*) AS sample_count,
         MIN(timestamp) AS min_timestamp,
         MAX(timestamp) AS max_timestamp,
         MIN(co2_ppm) AS min_value,
         MAX(co2_ppm) AS max_value,
         AVG(co2_ppm) AS avg_value
       FROM environment_readings
       WHERE archived = 0 AND co2_ppm IS NOT NULL
       GROUP BY location
     ) variables
     ORDER BY location, metric`;
const TRENDS_DL_FULL_SQL = `SELECT
           v.source_id,
           v.position,
           v.variable_key,
           v.prefix,
           COALESCE(v.display_name, v.name) AS name,
           v.unit,
           v.scale,
           COUNT(dv.id) AS sample_count,
           MIN(dv.timestamp) AS min_timestamp,
           MAX(dv.timestamp) AS max_timestamp,
           DATE_FORMAT(MIN(dv.timestamp), '%Y-%m-%dT%H:%i:%sZ') AS min_timestamp_iso,
           DATE_FORMAT(MAX(dv.timestamp), '%Y-%m-%dT%H:%i:%sZ') AS max_timestamp_iso,
           MIN(dv.raw_value * v.scale) AS min_value,
           MAX(dv.raw_value * v.scale) AS max_value,
           AVG(dv.raw_value * v.scale) AS avg_value
         FROM datalogger_variables v
         LEFT JOIN datalogger_values dv
           ON dv.source_id = v.source_id AND dv.variable_key = v.variable_key
         WHERE v.visible = 1 AND v.var_type = 'analog'
         GROUP BY v.source_id, v.position, v.variable_key, v.prefix, v.name, v.display_name, v.unit, v.scale
         ORDER BY v.position`;

const TRENDS_ENV_FAST_SQL = `SELECT m.metric, l.location, NULL AS sample_count,
       DATE_FORMAT(l.min_ts, '%Y-%m-%dT%H:%i:%sZ') AS min_timestamp_iso,
       DATE_FORMAT(l.max_ts, '%Y-%m-%dT%H:%i:%sZ') AS max_timestamp_iso,
       NULL AS min_value, NULL AS max_value, NULL AS avg_value
     FROM (SELECT location, MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts
           FROM environment_readings GROUP BY location) l
     CROSS JOIN (SELECT 'temperatureC' AS metric UNION ALL SELECT 'humidityRh' UNION ALL SELECT 'co2Ppm') m
     ORDER BY l.location, m.metric`;

// Loose index scan on idx_datalogger_values_variable_timestamp ("Using index for group-by").
const TRENDS_DL_FAST_SQL = `SELECT v.source_id, v.position, v.variable_key, v.prefix, COALESCE(v.display_name, v.name) AS name, v.unit, v.scale,
       NULL AS sample_count,
       DATE_FORMAT(r.min_ts, '%Y-%m-%dT%H:%i:%sZ') AS min_timestamp_iso,
       DATE_FORMAT(r.max_ts, '%Y-%m-%dT%H:%i:%sZ') AS max_timestamp_iso,
       NULL AS min_value, NULL AS max_value, NULL AS avg_value
     FROM datalogger_variables v
     LEFT JOIN (SELECT source_id, variable_key, MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts
                FROM datalogger_values GROUP BY source_id, variable_key) r
       ON r.source_id = v.source_id AND r.variable_key = v.variable_key
     WHERE v.visible = 1 AND v.var_type = 'analog'
     ORDER BY v.position`;

function withStatementTimeout(sql, seconds) {
  return `SET STATEMENT max_statement_time=${Number(seconds)} FOR ${sql}`;
}

function buildTrendVariables(environmentRows, dataloggerRows) {
  return [
    ...environmentRows.map(mapEnvironmentTrendVariable),
    ...dataloggerRows.map(mapDataloggerTrendVariable),
  ];
}

function refreshTrendStats() {
  if (trendStatsRefreshing) return trendStatsRefreshing;
  const started = Date.now();
  trendStatsRefreshing = (async () => {
    try {
      // Sequential to hold at most one pool connection.
      const environmentRows = await query(withStatementTimeout(TRENDS_ENV_FULL_SQL, TRENDS_STATS_MAX_SECONDS));
      const dataloggerRows = await query(withStatementTimeout(TRENDS_DL_FULL_SQL, TRENDS_STATS_MAX_SECONDS));
      // Env rows lacking data are dropped by the full query; keep that behaviour.
      trendStatsCache = { at: Date.now(), data: buildTrendVariables(environmentRows, dataloggerRows) };
      console.log(`[trends] stats cache refreshed in ${Date.now() - started} ms`);
    } catch (error) {
      console.error("[trends] stats refresh failed", error?.message ?? error);
    } finally {
      trendStatsRefreshing = null;
    }
  })();
  return trendStatsRefreshing;
}

refreshTrendStats();
setInterval(refreshTrendStats, TRENDS_STATS_REFRESH_MS).unref();

app.get(
  "/api/trends/variables",
  asyncRoute(async (_req, res) => {
    if (trendStatsCache) {
      if (Date.now() - trendStatsCache.at > TRENDS_STATS_REFRESH_MS) refreshTrendStats();
      res.set("X-Trends-Cache", "hit");
      return res.json(trendStatsCache.data);
    }
    const environmentRows = await query(withStatementTimeout(TRENDS_ENV_FAST_SQL, TRENDS_FAST_MAX_SECONDS));
    const dataloggerRows = await query(withStatementTimeout(TRENDS_DL_FAST_SQL, TRENDS_FAST_MAX_SECONDS));
    res.set("X-Trends-Cache", "warming");
    res.json(buildTrendVariables(environmentRows, dataloggerRows));
  }),
);

app.get(
  "/api/trends/series",
  asyncRoute(async (req, res) => {
    const variable = parseTrendVariableId(req.query.variableId);
    const to = req.query.to ? requiredDate(req.query.to, "to") : new Date();
    const from = req.query.from
      ? requiredDate(req.query.from, "from")
      : new Date(to.getTime() - 24 * 60 * 60 * 1000);
    if (from > to) return res.status(400).json({ error: "from must be before to" });

    const bucket = normalizeTrendBucket(req.query.bucket);
    const bucketSec = TREND_BUCKET_SECONDS[bucket] ?? 3600;
    if (variable.scope === "dl") {
      const params = [
        variable.sourceId,
        variable.variableKey,
        toMariaDbDateTime(from),
        toMariaDbDateTime(to),
      ];
      if (bucket === "raw") {
        const rows = await query(
          `SELECT DATE_FORMAT(dv.timestamp, '%Y-%m-%dT%H:%i:%sZ') AS timestamp_iso,
                  dv.raw_value * v.scale AS value
           FROM datalogger_values dv
           JOIN datalogger_variables v
             ON v.source_id = dv.source_id AND v.variable_key = dv.variable_key
           WHERE dv.source_id = ?
             AND dv.variable_key = ?
             AND dv.timestamp BETWEEN ? AND ?
           ORDER BY dv.timestamp ASC
           LIMIT 5000`,
          params,
        );
        return res.json(rows.map((row) => mapTrendPoint(row, bucket)));
      }

      const groupExpr =
        `FLOOR(UNIX_TIMESTAMP(dv.timestamp) / ${bucketSec})`;
      const timestampExpr =
        `DATE_FORMAT(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(dv.timestamp) / ${bucketSec}) * ${bucketSec}), '%Y-%m-%dT%H:%i:%sZ')`;
      const rows = await query(
        `SELECT
           ${timestampExpr} AS timestamp_iso,
           AVG(dv.raw_value * v.scale) AS value,
           MIN(dv.raw_value * v.scale) AS min_value,
           MAX(dv.raw_value * v.scale) AS max_value,
           COUNT(*) AS sample_count
         FROM datalogger_values dv
         JOIN datalogger_variables v
           ON v.source_id = dv.source_id AND v.variable_key = dv.variable_key
         WHERE dv.source_id = ?
           AND dv.variable_key = ?
           AND dv.timestamp BETWEEN ? AND ?
         GROUP BY ${groupExpr}
         ORDER BY ${groupExpr} ASC
         LIMIT 5000`,
        params,
      );
      return res.json(rows.map((row) => mapTrendPoint(row, bucket)));
    }

    const metric = trendMetricSql(variable.metric);
    const params = [variable.location, toMariaDbDateTime(from), toMariaDbDateTime(to)];

    if (bucket === "raw") {
      const rows = await query(
        `SELECT DATE_FORMAT(timestamp, '%Y-%m-%dT%H:%i:%sZ') AS timestamp_iso, ${metric.column} AS value
       FROM environment_readings
       WHERE archived = 0
         AND location = ?
         AND timestamp BETWEEN ? AND ?
         AND ${metric.column} IS NOT NULL
       ORDER BY timestamp ASC
       LIMIT 5000`,
        params,
      );
      return res.json(rows.map((row) => mapTrendPoint(row, bucket)));
    }

    const groupExpr =
      `FLOOR(UNIX_TIMESTAMP(timestamp) / ${bucketSec})`;
    const timestampExpr =
      `DATE_FORMAT(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(timestamp) / ${bucketSec}) * ${bucketSec}), '%Y-%m-%dT%H:%i:%sZ')`;
    const rows = await query(
      `SELECT
       ${timestampExpr} AS timestamp_iso,
       AVG(${metric.column}) AS value,
       MIN(${metric.column}) AS min_value,
       MAX(${metric.column}) AS max_value,
       COUNT(*) AS sample_count
     FROM environment_readings
     WHERE archived = 0
       AND location = ?
       AND timestamp BETWEEN ? AND ?
       AND ${metric.column} IS NOT NULL
     GROUP BY ${groupExpr}
     ORDER BY ${groupExpr} ASC
     LIMIT 5000`,
      params,
    );
    res.json(rows.map((row) => mapTrendPoint(row, bucket)));
  }),
);

app.get(
  "/api/datalogger/variables",
  asyncRoute(async (_req, res) => {
    const rows = await query(
      `SELECT ${DL_VAR_COLS} FROM datalogger_variables ORDER BY source_id, position`,
    );
    res.json(rows.map(mapDataloggerVariable));
  }),
);

const DL_VAR_COLS =
  "source_id, position, variable_key, prefix, name, display_name, unit, scale, visible, var_type, bits_json, archived, description";

// Partial update. Accepts prefix, scale, unit, visible, displayName, type ('analog'|'status'|'unused'),
// bits ([{bit, name, onColor?, offColor?, invert?, alarm?}], status words only).
app.put(
  "/api/datalogger/variables/:sourceId/:variableKey",
  asyncRoute(async (req, res) => {
    const sourceId = requiredString(req.params.sourceId, "sourceId");
    const variableKey = requiredString(req.params.variableKey, "variableKey");
    const sets = normalizeDataloggerVariablePatch(req.body);
    if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });
    const result = await query(
      `UPDATE datalogger_variables SET ${sets.map(([c]) => `${c} = ?`).join(", ")}
       WHERE source_id = ? AND variable_key = ?`,
      [...sets.map(([, v]) => v), sourceId, variableKey],
    );
    if (!result.affectedRows) return res.status(404).json({ error: "Datalogger variable not found" });
    const [row] = await query(`SELECT ${DL_VAR_COLS} FROM datalogger_variables WHERE source_id = ? AND variable_key = ?`, [
      sourceId,
      variableKey,
    ]);
    await refreshDataloggerTrendList().catch(() => undefined);
    res.json(mapDataloggerVariable(row));
  }),
);

// Latest raw/scaled value per datalogger variable (?keys=dl16,dl18; default all). One indexed
// "ORDER BY timestamp DESC LIMIT 1" lookup per key.
app.get(
  "/api/datalogger/latest",
  asyncRoute(async (req, res) => {
    const vars = await query(
      "SELECT source_id, variable_key, scale FROM datalogger_variables WHERE source_id = 'src-datalogger' ORDER BY position",
    );
    const wanted = String(req.query.keys || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const list = wanted.length ? vars.filter((v) => wanted.includes(v.variable_key)) : vars;
    const out = [];
    for (const v of list) {
      const [r] = await query(
        `SELECT raw_value, DATE_FORMAT(timestamp, '%Y-%m-%dT%H:%i:%sZ') AS ts FROM datalogger_values
         WHERE source_id = ? AND variable_key = ? ORDER BY timestamp DESC LIMIT 1`,
        [v.source_id, v.variable_key],
      );
      out.push({
        variableKey: v.variable_key,
        raw: r ? Number(r.raw_value) : null,
        value: r ? Number(r.raw_value) * Number(v.scale) : null,
        timestamp: r?.ts ?? null,
      });
    }
    res.json(out);
  }),
);

// ---- Alarm points (measurement points with an external alarm checker) ----
// GET /api/alarms/points            -> points with latest alarm state + current value
// GET /api/alarms/:pointId/events   -> start/clear transitions, newest first (?limit=20, max 200)
function jsonCol(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
async function alarmPointValue(valueSource) {
  const m = /^dl:([^:]+):(.+)$/.exec(valueSource || "");
  if (!m) return null;
  const [r] = await query(
    `SELECT dv.raw_value * v.scale AS value, DATE_FORMAT(dv.timestamp, '%Y-%m-%dT%H:%i:%s.%fZ') AS ts
     FROM datalogger_values dv JOIN datalogger_variables v ON v.source_id = dv.source_id AND v.variable_key = dv.variable_key
     WHERE dv.source_id = ? AND dv.variable_key = ? ORDER BY dv.timestamp DESC LIMIT 1`,
    [m[1], m[2]],
  );
  return r ? { value: Number(r.value), timestamp: r.ts.replace(/(\.\d{3})\d*Z$/, "$1Z") } : null;
}
function mapAlarmPoint(r, current) {
  const p = jsonCol(r.last_payload, {}) ?? {};
  return {
    id: r.id,
    name: r.name,
    topicPrefix: r.topic_prefix,
    valueSource: r.value_source ?? undefined,
    unit: r.unit ?? "",
    bits: jsonCol(r.bits_json, []),
    status: r.last_status === null ? null : Number(r.last_status),
    active: jsonCol(r.last_active, []) ?? [],
    since: p.since ?? {},
    alarmValue: Number.isFinite(Number(p.temp)) && p.temp !== null ? Number(p.temp) : null,
    lastReading: p.last_reading ?? null,
    checked: p.checked ?? null,
    lastMessageAt: r.last_message_iso ?? null,
    current,
  };
}
const ALARM_POINT_COLS = `id, name, topic_prefix, value_source, unit, bits_json, sort_order, last_status, last_active, last_payload,
  DATE_FORMAT(last_message_at, '%Y-%m-%dT%H:%i:%sZ') AS last_message_iso`;
app.get(
  "/api/alarms/points",
  asyncRoute(async (_req, res) => {
    const rows = await query(`SELECT ${ALARM_POINT_COLS} FROM alarm_points WHERE enabled = 1 ORDER BY sort_order, name`);
    const ctrl = new Map(
      (await query(`SELECT ${CONTROL_COLS} FROM alarm_point_controls`)).map((c) => [c.point_id, mapControls(c)]),
    );
    const out = [];
    for (const r of rows) out.push({ ...mapAlarmPoint(r, await alarmPointValue(r.value_source)), controls: ctrl.get(r.id) ?? null });
    res.json(out);
  }),
);
app.get(
  "/api/alarms/:pointId/events",
  asyncRoute(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
    const [pt] = await query("SELECT id FROM alarm_points WHERE id = ?", [req.params.pointId]);
    if (!pt) return res.status(404).json({ error: "Unknown alarm point" });
    const rows = await query(
      `SELECT id, alarm, bit, event, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%sZ') AS at_iso, value, status_word
       FROM alarm_events WHERE point_id = ? ORDER BY at DESC, id DESC LIMIT ${limit}`,
      [pt.id],
    );
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        alarm: r.alarm,
        bit: r.bit === null ? null : Number(r.bit),
        event: r.event,
        at: r.at_iso,
        value: r.value === null ? null : Number(r.value),
        statusWord: r.status_word === null ? null : Number(r.status_word),
      })),
    );
  }),
);

// ---- Alarm summary (SCADA-style alarm list across all points) ----
// GET /api/alarms/summary?hours=24&limit=500
// One row per alarm occurrence (start paired with its following clear). Rows that started in the window,
// plus alarms still active regardless of start time. priority: 1 = alarm level, 2 = warning level.
app.get(
  "/api/alarms/summary",
  asyncRoute(async (req, res) => {
    const hours = Math.min(24 * 90, Math.max(1, Number(req.query.hours) || 24));
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
    const points = await query("SELECT id, name, unit, bits_json FROM alarm_points");
    const meta = new Map(points.map((p) => [p.id, { name: p.name, unit: p.unit, bits: jsonCol(p.bits_json, []) ?? [] }]));
    const ev = await query(
      `SELECT id, point_id, alarm, bit, event, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%s.%fZ') AS at_iso, value
       FROM alarm_events WHERE event IN ('start','clear') ORDER BY at ASC, id ASC`,
    );
    const open = new Map();
    const rows = [];
    for (const e of ev) {
      const k = `${e.point_id}|${e.alarm}`;
      if (e.event === "start") {
        if (open.has(k)) continue; // duplicate start while active
        const m = meta.get(e.point_id);
        const level = m?.bits.find((b) => b.key === e.alarm)?.level ?? "alarm";
        const row = {
          id: Number(e.id), pointId: e.point_id, pointName: m?.name ?? e.point_id, unit: m?.unit ?? "",
          alarm: e.alarm, bit: e.bit === null ? null : Number(e.bit), priority: level === "alarm" ? 1 : 2,
          start: e.at_iso.replace(/\.(\d{3})\d*Z$/, ".$1Z"), end: null, active: true,
          value: e.value === null ? null : Number(e.value), endValue: null,
        };
        open.set(k, row);
        rows.push(row);
      } else {
        const row = open.get(k);
        if (!row) continue;
        row.end = e.at_iso.replace(/\.(\d{3})\d*Z$/, ".$1Z");
        row.active = false;
        row.endValue = e.value === null ? null : Number(e.value);
        open.delete(k);
      }
    }
    const from = Date.now() - hours * 3600_000;
    const now = Date.now();
    const out = rows
      .filter((r) => r.active || new Date(r.start).getTime() >= from || (r.end && new Date(r.end).getTime() >= from))
      .map((r) => ({ ...r, durationSec: Math.round(((r.end ? new Date(r.end).getTime() : now) - new Date(r.start).getTime()) / 1000) }))
      .sort((a, b) => b.start.localeCompare(a.start))
      .slice(0, limit);
    res.json({ hours, generatedAt: new Date().toISOString(), points: points.map((p) => ({ id: p.id, name: p.name })), rows: out });
  }),
);

// ---- Alarm point controls (ON/HEAT/COOL/SP), owned by Myko ----
// Word layout: bits 0-6 alarms (from the checker), bit7 ON, bit8 HEAT, bit9 COOL, bits10-14 SP (0-30),
// bit15 WA_DISABLED (WhatsApp alarms disabled; same as <key>dis). Heartbeat is only the separate "Heartbeat" counter.
// GET  /api/alarms/:pointId/controls
// PUT  /api/alarms/:pointId/controls  {on?, heat?, cool?, setpoint?}  -> stores, logs to alarm_events
//      (event 'control'), and publishes immediately (retained): <prefix>/json and Sensors/Mykovalvomo/Ctrl (all words).
const CTRL_SP_SHIFT = 10;
// Sensors/Mykovalvomo/Ctrl: one retained flat JSON for the PLC, exactly {"Heartbeat":123,"F1":25984,"T1":0} (Heartbeat first: PLC parser)
// (<key>dis = WhatsApp alarms disabled, also bit15 of the word: 0-6 alarms, 7-9 ON/HEAT/COOL, 10-14 SP, 15 WA_DISABLED)
// (point id -> short key; the checker uses the same map).
const PLC_TOPIC = "Sensors/Mykovalvomo/Ctrl";
const PLC_KEYS = { ColdStorage1: "F1", Terrario1: "T1" };
const PLC_ORDER = Object.keys(PLC_KEYS);
function controlWord(c) {
  return ((c.on ? 1 : 0) << 7) | ((c.heat ? 1 : 0) << 8) | ((c.cool ? 1 : 0) << 9) | ((c.setpoint & 0x1f) << CTRL_SP_SHIFT);
}
function mapControls(r) {
  return {
    on: Boolean(r.on_state),
    heat: Boolean(r.heat),
    cool: Boolean(r.cool),
    setpoint: Number(r.setpoint),
    limits: {
      warnDelta: Number(r.warn_delta),
      warnMin: Number(r.warn_min),
      warnBoth: Boolean(r.warn_both),
      highDelta: Number(r.high_delta),
      highMin: Number(r.high_min),
      lowDelta: Number(r.low_delta),
      lowMin: Number(r.low_min),
    },
    alarmsDisabledUntil: r.disabled_iso && new Date(r.disabled_iso) > new Date() ? r.disabled_iso : null,
    updatedBy: r.updated_by ?? undefined,
    updatedAt: r.updated_iso ?? undefined,
  };
}
const CONTROL_COLS =
  "point_id, on_state, heat, cool, setpoint, warn_delta, warn_min, warn_both, high_delta, high_min, low_delta, low_min, " +
  "DATE_FORMAT(alarms_disabled_until, '%Y-%m-%dT%H:%i:%sZ') AS disabled_iso, updated_by, DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_iso";
const LIMIT_FIELDS = [
  ["warnDelta", "warn_delta", "WARN Δ", "delta"],
  ["warnMin", "warn_min", "WARN min", "min"],
  ["highDelta", "high_delta", "HIGH Δ", "delta"],
  ["highMin", "high_min", "HIGH min", "min"],
  ["lowDelta", "low_delta", "LOW Δ", "delta"],
  ["lowMin", "low_min", "LOW min", "min"],
];
const helTime = (d) => {
  const f = (o, x = d) => new Intl.DateTimeFormat("fi-FI", { timeZone: "Europe/Helsinki", ...o }).format(x);
  const sameDay = f({ dateStyle: "short" }) === f({ dateStyle: "short" }, new Date());
  return (sameDay ? "" : f({ day: "numeric", month: "numeric" }) + " ") + f({ hour: "2-digit", minute: "2-digit" }).replace(".", ":");
};
let mqttPub = null;
function mqttPublisher() {
  if (!mqttPub) {
    mqttPub = mqtt.connect(process.env.MQTT_URL || "mqtt://192.168.1.51:1883", {
      clientId: `myko-backend-controls-${process.pid}`,
      reconnectPeriod: 5000,
    });
    mqttPub.on("error", (e) => console.error("[controls mqtt]", e.message));
  }
  return mqttPub;
}
function publishRetained(topic, message) {
  const c = mqttPublisher();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("MQTT publish timeout")), 8000);
    c.publish(topic, message, { qos: 1, retain: true }, (err) => {
      clearTimeout(t);
      err ? reject(err) : resolve();
    });
  });
}
app.get(
  "/api/alarms/:pointId/controls",
  asyncRoute(async (req, res) => {
    const [r] = await query(`SELECT ${CONTROL_COLS} FROM alarm_point_controls WHERE point_id = ?`, [req.params.pointId]);
    if (!r) return res.status(404).json({ error: "No controls for this point" });
    res.json(mapControls(r));
  }),
);
app.put(
  "/api/alarms/:pointId/controls",
  asyncRoute(async (req, res) => {
    const pointId = req.params.pointId;
    const b = req.body ?? {};
    const bad = (m) => res.status(400).json({ error: m });
    for (const k of ["on", "heat", "cool"]) if (k in b && typeof b[k] !== "boolean") return bad(`${k} must be true/false`);
    if ("setpoint" in b && !(Number.isInteger(b.setpoint) && b.setpoint >= 0 && b.setpoint <= 30))
      return bad("setpoint must be an integer 0..30");
    // disableMinutes: 1..1440 disables alarms for that long; 0 re-enables now
    if ("disableMinutes" in b && !(Number.isInteger(b.disableMinutes) && b.disableMinutes >= 0 && b.disableMinutes <= 1440))
      return bad("disableMinutes must be an integer 0..1440 (max 24 h)");
    const lim = b.limits ?? {};
    if (typeof lim !== "object") return bad("limits must be an object");
    for (const [k, , label, kind] of LIMIT_FIELDS) {
      if (!(k in lim)) continue;
      const v = lim[k];
      if (kind === "delta" && !(typeof v === "number" && v >= 0.1 && v <= 20 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-9))
        return bad(`${label} must be 0.1..20 °C (0.1 steps)`);
      if (kind === "min" && !(Number.isInteger(v) && v >= 0 && v <= 1440)) return bad(`${label} must be an integer 0..1440 min`);
    }
    if ("warnBoth" in lim && typeof lim.warnBoth !== "boolean") return bad("warnBoth must be true/false");
    const [pt] = await query(`SELECT id, topic_prefix, last_status, last_payload FROM alarm_points WHERE id = ?`, [pointId]);
    const [old] = await query(`SELECT ${CONTROL_COLS} FROM alarm_point_controls WHERE point_id = ?`, [pointId]);
    if (!pt || !old) return res.status(404).json({ error: "No controls for this point" });
    const prev = mapControls(old);
    const next = {
      on: "on" in b ? b.on : prev.on,
      heat: "heat" in b ? b.heat : prev.heat,
      cool: "cool" in b ? b.cool : prev.cool,
      setpoint: "setpoint" in b ? b.setpoint : prev.setpoint,
    };
    const nextLim = { ...prev.limits };
    for (const [k] of LIMIT_FIELDS) if (k in lim) nextLim[k] = lim[k];
    if ("warnBoth" in lim) nextLim.warnBoth = lim.warnBoth;
    if (nextLim.highDelta < nextLim.warnDelta) return bad("HIGH Δ must be ≥ WARN Δ");
    if (nextLim.lowDelta < (nextLim.warnBoth ? nextLim.warnDelta : 0)) return bad("LOW Δ must be ≥ WARN Δ");
    let disabledUntil = prev.alarmsDisabledUntil;
    const changes = [];
    for (const k of ["on", "heat", "cool"]) if (next[k] !== prev[k]) changes.push([k.toUpperCase(), next[k] ? 1 : 0, `${k.toUpperCase()} ${next[k] ? "on" : "off"}`]);
    if (next.setpoint !== prev.setpoint) changes.push(["SP", next.setpoint, `SP ${prev.setpoint}→${next.setpoint}`]);
    const limChanged = [];
    for (const [k, , label] of LIMIT_FIELDS) if (nextLim[k] !== prev.limits[k]) limChanged.push(`${label} ${prev.limits[k]}→${nextLim[k]}`);
    if (nextLim.warnBoth !== prev.limits.warnBoth) limChanged.push(`WARN ${nextLim.warnBoth ? "±" : "+"}`);
    if (limChanged.length) changes.push(["LIMITS", null, `Rajat: ${limChanged.join(", ")}`.slice(0, 80)]);
    if ("disableMinutes" in b) {
      if (b.disableMinutes === 0) {
        if (prev.alarmsDisabledUntil) changes.push(["DIS", 0, "Hälytykset palautettu"]);
        disabledUntil = null;
      } else {
        const until = new Date(Date.now() + b.disableMinutes * 60000);
        disabledUntil = until.toISOString().slice(0, 19) + "Z";
        changes.push(["DIS", 1, `Hälytykset pois päältä klo ${helTime(until)} asti`]);
      }
    }
    if (changes.length === 0) return res.json({ controls: prev, word: null, published: false });
    const disabled = Boolean(disabledUntil);
    // "disabled" only mutes WhatsApp in the checker; alarm bits stay as they are
    const alarmBits = pt.last_status === null ? 0 : Number(pt.last_status) & 0x7f;
    const word = alarmBits | controlWord(next) | (disabled ? 0x8000 : 0); // bit15 = WhatsApp alarms disabled
    await query(
      `UPDATE alarm_point_controls SET on_state = ?, heat = ?, cool = ?, setpoint = ?, warn_delta = ?, warn_min = ?, warn_both = ?,
         high_delta = ?, high_min = ?, low_delta = ?, low_min = ?, alarms_disabled_until = ?, updated_by = ? WHERE point_id = ?`,
      [
        next.on ? 1 : 0, next.heat ? 1 : 0, next.cool ? 1 : 0, next.setpoint,
        nextLim.warnDelta, nextLim.warnMin, nextLim.warnBoth ? 1 : 0, nextLim.highDelta, nextLim.highMin, nextLim.lowDelta, nextLim.lowMin,
        disabledUntil ? disabledUntil.replace("T", " ").replace("Z", "") : null, "dashboard", pointId,
      ],
    );
    for (const [, value, label] of changes)
      await query(
        "INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, NULL, 'control', UTC_TIMESTAMP(3), ?, ?)",
        [pointId, label, value, word],
      );
    // Publish the merged word now (the checker re-publishes the same layout every minute).
    let published = true;
    let publishError;
    try {
      const last = jsonCol(pt.last_payload, {}) ?? {};
      const js = {
        ...last,
        status: word,
        alarm_bits: alarmBits,
        alarms_disabled: disabled,
        alarms_disabled_until: disabledUntil,
        controls: { on: next.on ? 1 : 0, heat: next.heat ? 1 : 0, cool: next.cool ? 1 : 0, setpoint: next.setpoint },
        layout: { alarms: "0-6", ON: 7, HEAT: 8, COOL: 9, SP: "10-14", WA_DISABLED: 15 },
        control_changed: new Date().toISOString(),
      };
      await publishRetained(`${pt.topic_prefix}/json`, JSON.stringify(js));
      // PLC topic: {"F1":word,"T1":word,"Heartbeat":counter}
      const others = await query(`SELECT id, last_status, last_payload FROM alarm_points WHERE id IN (${PLC_ORDER.map(() => "?").join(",")})`, PLC_ORDER);
      const byId = new Map(others.map((o) => [o.id, o]));
      // key order matters: Heartbeat first
      const plc = { Heartbeat: Number(jsonCol(byId.get(PLC_ORDER[0])?.last_payload, {})?.heartbeat?.counter ?? 0) };
      for (const id of PLC_ORDER) plc[PLC_KEYS[id]] = id === pointId ? word : Number(byId.get(id)?.last_status ?? 0);
      await publishRetained(PLC_TOPIC, JSON.stringify(plc));
    } catch (e) {
      published = false;
      publishError = e.message;
    }
    const [r] = await query(`SELECT ${CONTROL_COLS} FROM alarm_point_controls WHERE point_id = ?`, [pointId]);
    res.json({ controls: mapControls(r), word, published, publishError });
  }),
);

// After a variable edit, rebuild only the datalogger part of the cached trend list (fast query),
// keeping cached stats for unchanged entries.
async function refreshDataloggerTrendList() {
  if (!trendStatsCache) return;
  const rows = await query(withStatementTimeout(TRENDS_DL_FAST_SQL, TRENDS_FAST_MAX_SECONDS));
  const old = new Map(trendStatsCache.data.map((v) => [v.id, v]));
  const dl = rows.map(mapDataloggerTrendVariable).map((v) => {
    const prev = old.get(v.id);
    return prev ? { ...prev, label: v.label, unit: v.unit, prefix: v.prefix } : v;
  });
  trendStatsCache = {
    ...trendStatsCache,
    data: [...trendStatsCache.data.filter((v) => v.source !== "datalogger_values"), ...dl],
  };
}

app.get(
  "/api/trends/presets",
  asyncRoute(async (req, res) => {
    const viewKey = normalizeViewKey(req.query.viewKey);
    const rows = await query(
      "SELECT * FROM trend_presets WHERE view_key = ? ORDER BY updated_at DESC, name",
      [viewKey],
    );
    res.json(rows.map(mapTrendPreset));
  }),
);

app.post(
  "/api/trends/presets",
  asyncRoute(async (req, res) => {
    const preset = normalizeTrendPreset(req.body);
    await query(
      `INSERT INTO trend_presets (id, view_key, name, layout_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         view_key=VALUES(view_key),
         name=VALUES(name),
         layout_json=VALUES(layout_json)`,
      [preset.id, preset.viewKey, preset.name, JSON.stringify(preset.layout)],
    );
    const [saved] = await query("SELECT * FROM trend_presets WHERE id = ?", [preset.id]);
    res.status(201).json(mapTrendPreset(saved));
  }),
);

app.delete(
  "/api/trends/presets/:id",
  asyncRoute(async (req, res) => {
    await query("DELETE FROM trend_presets WHERE id = ?", [String(req.params.id)]);
    res.json({ ok: true });
  }),
);

app.get(
  "/api/state/summary",
  asyncRoute(async (_req, res) => {
    const [rows] = await query(
      `SELECT
       (SELECT COUNT(*) FROM strains) AS strains,
       (SELECT COUNT(*) FROM units) AS units,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM transfers) AS transfers`,
    );
    res.json({
      ok: true,
      source: "mariadb",
      counts: {
        strains: Number(rows.strains),
        units: Number(rows.units),
        events: Number(rows.events),
        transfers: Number(rows.transfers),
      },
    });
  }),
);

app.get(
  "/api/strains",
  asyncRoute(async (_req, res) => {
    const rows = await query("SELECT * FROM strains ORDER BY code");
    res.json(rows.map(mapStrain));
  }),
);

app.get(
  "/api/strains/:code",
  asyncRoute(async (req, res) => {
    const code = normalizeStrainCode(req.params.code);
    const rows = await query("SELECT * FROM strains WHERE code = ?", [code]);
    if (rows.length === 0) return res.status(404).json({ error: `Strain #${code} not found` });
    res.json(mapStrain(rows[0]));
  }),
);

app.put(
  "/api/strains/:code",
  asyncRoute(async (req, res) => {
    const originalCode = normalizeStrainCode(req.params.code);
    const body = normalizeStrainBody(req.body, { requireCode: false });
    const nextCode = normalizeStrainCode(body.code ?? originalCode);

    const strain = await withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        const existingRows = await conn.query("SELECT * FROM strains WHERE code = ?", [
          originalCode,
        ]);
        if (existingRows.length === 0) {
          await conn.rollback();
          return null;
        }

        if (nextCode !== originalCode) {
          const duplicateRows = await conn.query("SELECT code FROM strains WHERE code = ?", [
            nextCode,
          ]);
          if (duplicateRows.length > 0) throw new Error(`Strain #${nextCode} already exists`);
        }

        await conn.query(
          `UPDATE strains
         SET code = ?, name = ?, species = ?, description = ?, notes = ?, archived = ?
         WHERE code = ?`,
          [
            nextCode,
            body.name,
            body.species,
            body.description,
            body.notes,
            boolToDb(body.archived),
            originalCode,
          ],
        );

        const [updated] = await conn.query("SELECT * FROM strains WHERE code = ?", [nextCode]);
        await conn.commit();
        return mapStrain(updated);
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    });

    if (!strain) return res.status(404).json({ error: `Strain #${originalCode} not found` });
    res.json(strain);
  }),
);

app.post(
  "/api/strains",
  asyncRoute(async (req, res) => {
    const body = normalizeStrainBody(req.body);
    const code = normalizeStrainCode(body.code);
    const existing = await query("SELECT code FROM strains WHERE code = ?", [code]);
    if (existing.length > 0) throw new Error(`Strain #${code} already exists`);

    await query(
      `INSERT INTO strains (code, name, species, description, notes, archived)
     VALUES (?, ?, ?, ?, ?, ?)`,
      [code, body.name, body.species, body.description, body.notes, boolToDb(body.archived)],
    );

    const [created] = await query("SELECT * FROM strains WHERE code = ?", [code]);
    res.status(201).json(mapStrain(created));
  }),
);

app.get(
  "/api/units",
  asyncRoute(async (_req, res) => {
    const rows = await query("SELECT * FROM units ORDER BY batch_time DESC, code");
    res.json(rows.map(mapUnit));
  }),
);

app.get(
  "/api/units/:code",
  asyncRoute(async (req, res) => {
    const code = String(req.params.code);
    const rows = await query("SELECT * FROM units WHERE code = ?", [code]);
    if (rows.length === 0) return res.status(404).json({ error: `Unit ${code} not found` });
    res.json(mapUnit(rows[0]));
  }),
);

app.post(
  "/api/units",
  asyncRoute(async (req, res) => {
    const code = requiredString(req.body?.code, "unit.code").trim().toUpperCase();
    if (!code) throw new Error("unit.code is required");
    const body = normalizeUnitBody(req.body);

    const unit = await withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        const existingRows = await conn.query("SELECT code FROM units WHERE code = ?", [code]);
        if (existingRows.length > 0) throw new Error(`Unit ${code} already exists`);
        await assertUnitReferences(conn, code, body);

        await conn.query(
          `INSERT INTO units
           (code, type, strain_code, status, batch_time, parent_unit_code, substrate, current_location, description, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            code,
            body.type,
            body.strainCode,
            body.status,
            toMariaDbDateTime(new Date(body.batchTime)),
            body.parentUnitCode,
            body.substrate,
            body.currentLocation,
            body.description,
            body.notes,
          ],
        );

        {
          const origins = normalizeOrigins(req.body?.origins);
          if (!origins.length && body.parentUnitCode) origins.push({ type: "UNIT", parent: body.parentUnitCode, note: "Set at creation" });
          if (origins.length) await writeOrigins(conn, code, origins, { replace: false });
          if (body.currentLocation)
            await conn.query("INSERT INTO unit_locations (unit_code, location, moved_at, note) VALUES (?, ?, ?, ?)",
              [code, body.currentLocation, toMariaDbDateTime(new Date(body.batchTime)), "Set at creation"]);
        }
        const [created] = await conn.query("SELECT * FROM units WHERE code = ?", [code]);
        await conn.commit();
        return mapUnit(created);
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    });

    res.status(201).json(unit);
  }),
);

app.put(
  "/api/units/:code",
  asyncRoute(async (req, res) => {
    const code = String(req.params.code);
    const body = normalizeUnitBody(req.body);

    const unit = await withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        const existingRows = await conn.query("SELECT code FROM units WHERE code = ?", [code]);
        if (existingRows.length === 0) {
          await conn.rollback();
          return null;
        }
        await assertUnitReferences(conn, code, body);

        // Editing "current location" is a move: record it in the location history too.
        if (body.currentLocation) {
          const [latest] = await conn.query(
            `SELECT location FROM unit_locations WHERE unit_code = ? AND archived = 0
             ORDER BY moved_at DESC, id DESC LIMIT 1`,
            [code],
          );
          if (!latest || latest.location !== body.currentLocation) {
            await conn.query(
              "INSERT INTO unit_locations (unit_code, location, moved_at, note) VALUES (?, ?, ?, ?)",
              [code, body.currentLocation, toMariaDbDateTime(new Date()), "Set via unit edit"],
            );
          }
        }

        await conn.query(
          `UPDATE units
         SET type = ?, strain_code = ?, status = ?, batch_time = ?, parent_unit_code = ?,
             substrate = ?, current_location = COALESCE(?, current_location), description = ?, notes = ?
         WHERE code = ?`,
          [
            body.type,
            body.strainCode,
            body.status,
            toMariaDbDateTime(new Date(body.batchTime)),
            body.parentUnitCode,
            body.substrate,
            body.currentLocation,
            body.description,
            body.notes,
            code,
          ],
        );

        // Legacy single-parent field: make sure it is also an origin (origins are the source of truth).
        if (body.parentUnitCode) {
          const has = await conn.query("SELECT 1 FROM unit_origins WHERE unit_code = ? AND origin_type = 'UNIT' AND parent_unit_code = ?", [code, body.parentUnitCode]);
          if (!has.length) await writeOrigins(conn, code, [{ type: "UNIT", parent: body.parentUnitCode, note: "Set via unit edit" }], { replace: false });
        }
        const [updated] = await conn.query("SELECT * FROM units WHERE code = ?", [code]);
        await conn.commit();
        return mapUnit(updated);
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    });

    if (!unit) return res.status(404).json({ error: `Unit ${code} not found` });
    res.json(unit);
  }),
);

app.post(
  "/api/units/archive",
  asyncRoute(async (req, res) => {
    const unitCodes = Array.isArray(req.body?.unitCodes)
      ? Array.from(new Set(req.body.unitCodes.map((code) => String(code).trim()).filter(Boolean)))
      : [];
    if (unitCodes.length === 0)
      return res.status(400).json({ error: "unitCodes must contain at least one unit" });

    const counts = await withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        const placeholders = unitCodes.map(() => "?").join(", ");
        const existingRows = await conn.query(
          `SELECT code, status FROM units WHERE code IN (${placeholders})`,
          unitCodes,
        );
        const existingCodes = new Set(existingRows.map((row) => row.code));
        const missing = unitCodes.filter((code) => !existingCodes.has(code));
        if (missing.length > 0) throw new Error(`Unknown units: ${missing.join(", ")}`);

        await conn.query(
          `UPDATE units SET status = 'ARCHIVED' WHERE code IN (${placeholders})`,
          unitCodes,
        );

        const now = new Date();
        for (const [index, code] of unitCodes.entries()) {
          await conn.query(
            `INSERT INTO events (id, function_code, unit_code, event_time, title, note, status_change)
           VALUES (?, 'OBS', ?, ?, 'Physical unit archived', 'Bulk archived from Units list.', 'ARCHIVED')`,
            [`evt-${now.getTime()}-${index}`, code, toMariaDbDateTime(now)],
          );
        }

        await conn.commit();
        return { units: unitCodes.length, events: unitCodes.length };
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    });

    res.json({ ok: true, counts });
  }),
);

app.get(
  "/api/events",
  asyncRoute(async (_req, res) => {
    const rows = await query("SELECT * FROM events ORDER BY event_time DESC, id");
    res.json(rows.map(mapEvent));
  }),
);

app.get(
  "/api/transfers",
  asyncRoute(async (_req, res) => {
    const rows = await query("SELECT * FROM transfers ORDER BY transfer_time DESC, id");
    res.json(rows.map(mapTransfer));
  }),
);

app.get(
  "/api/taxonomy",
  asyncRoute(async (_req, res) => {
    const rows = await query("SELECT * FROM taxonomy_terms ORDER BY category, value");
    res.json(mapTaxonomy(rows));
  }),
);

app.get(
  ["/api/data/state", "/api/state"],
  asyncRoute(async (_req, res) => {
    const [strains, units, events, transfers, taxonomyRows] = await Promise.all([
      query("SELECT * FROM strains ORDER BY code"),
      query("SELECT * FROM units ORDER BY batch_time, code"),
      query("SELECT * FROM events ORDER BY event_time, id"),
      query("SELECT * FROM transfers ORDER BY transfer_time, id"),
      query("SELECT * FROM taxonomy_terms ORDER BY category, value"),
    ]);

    res.json({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      strains: strains.map(mapStrain),
      units: units.map(mapUnit),
      events: events.map(mapEvent),
      transfers: transfers.map(mapTransfer),
      taxonomy: mapTaxonomy(taxonomyRows),
    });
  }),
);

app.post(
  ["/api/data/import", "/api/state/import"],
  asyncRoute(async (req, res) => {
    const mode = normalizeImportMode(req.query.mode, req.query.replace);
    const replace = mode === "replace";
    const state = normalizeImportState(req.body);

    const counts = await withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        await conn.query("SET FOREIGN_KEY_CHECKS=0");
        if (replace) {
          await conn.query("DELETE FROM taxonomy_terms");
          await conn.query("DELETE FROM transfers");
          await conn.query("DELETE FROM unit_origins");
          await conn.query("DELETE FROM events");
          await conn.query("DELETE FROM units");
          await conn.query("DELETE FROM strains");
        }

        for (const strain of state.strains) {
          await conn.query(
            `INSERT INTO strains (code, name, species, description, notes, archived)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             name=VALUES(name), species=VALUES(species), description=VALUES(description),
             notes=VALUES(notes), archived=VALUES(archived)`,
            [
              strain.code,
              strain.name,
              strain.species,
              strain.description,
              strain.notes,
              boolToDb(strain.archived),
            ],
          );
        }

        for (const unit of state.units) {
          await conn.query(
            `INSERT INTO units
            (code, type, strain_code, status, batch_time, parent_unit_code, substrate, current_location, description, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             type=VALUES(type), strain_code=VALUES(strain_code), status=VALUES(status), batch_time=VALUES(batch_time),
             parent_unit_code=VALUES(parent_unit_code), substrate=VALUES(substrate), current_location=VALUES(current_location),
             description=VALUES(description), notes=VALUES(notes)`,
            [
              unit.code,
              unit.type,
              unit.strainCode,
              unit.status,
              toMariaDbDateTime(new Date(unit.batchTime)),
              unit.parentUnitCode,
              unit.substrate,
              unit.currentLocation,
              unit.description,
              unit.notes,
            ],
          );
        }

        for (const event of state.events) {
          await conn.query(
            `INSERT INTO events
            (id, function_code, unit_code, event_time, title, description, note, temperature_c, humidity_rh, qc_tags, status_change, archived)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             function_code=VALUES(function_code), unit_code=VALUES(unit_code), event_time=VALUES(event_time),
             title=VALUES(title), description=VALUES(description), note=VALUES(note),
             temperature_c=VALUES(temperature_c), humidity_rh=VALUES(humidity_rh), qc_tags=VALUES(qc_tags),
             status_change=VALUES(status_change), archived=VALUES(archived)`,
            [
              event.id,
              event.functionCode,
              event.unitCode,
              toMariaDbDateTime(new Date(event.eventTime)),
              event.title,
              event.description,
              event.note,
              finiteOrNull(event.temperatureC),
              finiteOrNull(event.humidityRh),
              event.qcTags ? JSON.stringify(event.qcTags) : null,
              event.statusChange,
              boolToDb(event.archived),
            ],
          );
        }

        for (const transfer of state.transfers) {
          await conn.query(
            `INSERT INTO transfers
            (id, source_unit_code, target_unit_code, transfer_time, method, amount, description, note, archived)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             source_unit_code=VALUES(source_unit_code), target_unit_code=VALUES(target_unit_code),
             transfer_time=VALUES(transfer_time), method=VALUES(method), amount=VALUES(amount),
             description=VALUES(description), note=VALUES(note), archived=VALUES(archived)`,
            [
              transfer.id,
              transfer.sourceUnitCode,
              transfer.targetUnitCode,
              toMariaDbDateTime(new Date(transfer.transferTime)),
              transfer.method,
              transfer.amount,
              transfer.description,
              transfer.note,
              boolToDb(transfer.archived),
            ],
          );
        }

        for (const [category, values] of Object.entries(state.taxonomy)) {
          for (const value of values) {
            await conn.query(
              `INSERT INTO taxonomy_terms (category, value)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE value=VALUES(value)`,
              [category, value],
            );
          }
        }

        await conn.query("SET FOREIGN_KEY_CHECKS=1");
        await conn.commit();
        return {
          strains: state.strains.length,
          units: state.units.length,
          events: state.events.length,
          transfers: state.transfers.length,
          taxonomyTerms: Object.values(state.taxonomy).reduce(
            (sum, values) => sum + values.length,
            0,
          ),
        };
      } catch (error) {
        await conn.query("SET FOREIGN_KEY_CHECKS=1");
        await conn.rollback();
        throw error;
      }
    });

    res.status(201).json({ ok: true, mode, counts });
  }),
);

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error.message || "Request failed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Myko backend listening on http://0.0.0.0:${PORT}`);
});

function mapEnvironmentTrendVariable(row) {
  const metric = row.metric;
  return {
    id: `env:${metric}:${row.location}`,
    source: "environment_readings",
    location: row.location,
    metric,
    label: `${row.location} - ${trendMetricLabel(metric)}`,
    unit: trendMetricUnit(metric),
    sampleCount: row.sample_count === null ? 0 : Number(row.sample_count),
    from: row.min_timestamp_iso ?? new Date(row.min_timestamp).toISOString(),
    to: row.max_timestamp_iso ?? new Date(row.max_timestamp).toISOString(),
    min: row.min_value === null ? undefined : Number(row.min_value),
    max: row.max_value === null ? undefined : Number(row.max_value),
    avg: row.avg_value === null ? undefined : Number(row.avg_value),
  };
}

function mapDataloggerTrendVariable(row) {
  const prefix = row.prefix ?? "Sensor";
  return {
    id: `dl:${row.source_id}:${row.variable_key}`,
    source: "datalogger_values",
    location: "DATALOGGER",
    metric: row.variable_key,
    prefix,
    label: `${prefix} - Datalogger ${String(row.position).padStart(2, "0")} - ${row.name}`,
    unit: row.unit ?? "",
    sampleCount: row.sample_count === null ? 0 : Number(row.sample_count),
    from:
      row.min_timestamp_iso ??
      (row.min_timestamp ? new Date(row.min_timestamp).toISOString() : undefined),
    to:
      row.max_timestamp_iso ??
      (row.max_timestamp ? new Date(row.max_timestamp).toISOString() : undefined),
    min: row.min_value === null ? undefined : Number(row.min_value),
    max: row.max_value === null ? undefined : Number(row.max_value),
    avg: row.avg_value === null ? undefined : Number(row.avg_value),
  };
}

function mapDataloggerVariable(row) {
  let bits = row.bits_json;
  if (typeof bits === "string") {
    try { bits = JSON.parse(bits); } catch { bits = []; }
  }
  return {
    sourceId: row.source_id,
    position: Number(row.position),
    variableKey: row.variable_key,
    prefix: row.prefix ?? "Sensor",
    name: row.name,
    displayName: row.display_name ?? undefined,
    unit: row.unit ?? "",
    scale: Number(row.scale),
    visible: Boolean(row.visible),
    type: row.var_type ?? "analog",
    bits: Array.isArray(bits) ? bits : [],
    archived: Boolean(row.archived),
    description: row.description ?? undefined,
  };
}

function mapTrendPoint(row, bucket) {
  return stripUndefined({
    timestamp: row.timestamp_iso ?? new Date(row.timestamp).toISOString(),
    value: row.value === null ? undefined : Number(row.value),
    min: row.min_value === null || row.min_value === undefined ? undefined : Number(row.min_value),
    max: row.max_value === null || row.max_value === undefined ? undefined : Number(row.max_value),
    sampleCount: row.sample_count === undefined ? undefined : Number(row.sample_count),
    bucket,
  });
}

function mapTrendPreset(row) {
  return {
    id: row.id,
    viewKey: row.view_key ?? "myko",
    name: row.name,
    layout: parseJsonObject(row.layout_json) ?? { widgets: [] },
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapReading(row) {
  return {
    id: Number(row.id),
    timestamp: row.timestamp_iso ?? new Date(row.timestamp).toISOString(),
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

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function mapStrain(row) {
  return stripUndefined({
    code: row.code,
    name: row.name,
    species: row.species,
    description: row.description,
    notes: row.notes,
    archived: Boolean(row.archived),
  });
}

function mapUnit(row) {
  return stripUndefined({
    code: row.code,
    type: row.type,
    strainCode: row.strain_code ?? null,
    status: row.status,
    batchTime: new Date(row.batch_time).toISOString(),
    parentUnitCode: row.parent_unit_code,
    substrate: row.substrate,
    currentLocation: row.current_location,
    description: row.description,
    notes: row.notes,
  });
}

function mapEvent(row) {
  return stripUndefined({
    id: row.id,
    functionCode: row.function_code,
    unitCode: row.unit_code,
    eventTime: new Date(row.event_time).toISOString(),
    title: row.title,
    description: row.description,
    note: row.note,
    temperatureC: row.temperature_c === null ? undefined : Number(row.temperature_c),
    humidityRh: row.humidity_rh === null ? undefined : Number(row.humidity_rh),
    qcTags: parseJsonArray(row.qc_tags),
    statusChange: row.status_change,
    archived: Boolean(row.archived),
  });
}

function mapTransfer(row) {
  return stripUndefined({
    id: row.id,
    sourceUnitCode: row.source_unit_code,
    targetUnitCode: row.target_unit_code,
    transferTime: new Date(row.transfer_time).toISOString(),
    method: row.method,
    amount: row.amount,
    description: row.description,
    note: row.note,
    archived: Boolean(row.archived),
  });
}

function mapTaxonomy(rows) {
  const taxonomy = { functions: [], types: [], statuses: [], qcTags: [], locations: [], substrates: [] };
  for (const row of rows) {
    if (Array.isArray(taxonomy[row.category])) taxonomy[row.category].push(row.value);
  }
  return taxonomy;
}

function normalizeImportState(input) {
  if (!input || typeof input !== "object") throw new Error("JSON object is required");
  const strains = arrayOf(input.strains, "strains").map((strain) => ({
    code: requiredString(strain.code, "strain.code").replace(/^#+/, "").trim().toUpperCase(),
    name: requiredString(strain.name, "strain.name"),
    species: requiredString(strain.species, "strain.species"),
    description: optionalString(strain.description),
    notes: optionalString(strain.notes),
    archived: Boolean(strain.archived),
  }));
  const strainCodes = new Set(strains.map((strain) => strain.code));

  const units = arrayOf(input.units, "units").map((unit) => {
    const normalized = {
      code: requiredString(unit.code, "unit.code"),
      type: requiredString(unit.type, "unit.type").toUpperCase(),
      strainCode: optionalStrainCode(unit.strainCode),
      status: requiredString(unit.status, "unit.status").toUpperCase(),
      batchTime: requiredDateString(unit.batchTime, "unit.batchTime"),
      parentUnitCode: optionalString(unit.parentUnitCode),
      substrate: optionalString(unit.substrate),
      currentLocation: optionalString(unit.currentLocation),
      description: optionalString(unit.description),
      notes: optionalString(unit.notes),
    };
    if (normalized.strainCode && !strainCodes.has(normalized.strainCode))
      throw new Error(`Unit ${normalized.code} references missing strain ${normalized.strainCode}`);
    return normalized;
  });
  const unitCodes = new Set(units.map((unit) => unit.code));
  for (const unit of units) {
    if (unit.parentUnitCode && !unitCodes.has(unit.parentUnitCode)) {
      throw new Error(`Unit ${unit.code} references missing parent unit ${unit.parentUnitCode}`);
    }
  }

  const events = arrayOf(input.events, "events").map((event) => {
    const normalized = {
      id: requiredString(event.id, "event.id"),
      functionCode: requiredString(event.functionCode, "event.functionCode").toUpperCase(),
      unitCode: requiredString(event.unitCode, "event.unitCode"),
      eventTime: requiredDateString(event.eventTime, "event.eventTime"),
      title: requiredString(event.title, "event.title"),
      description: optionalString(event.description),
      note: optionalString(event.note),
      temperatureC: finiteOrNull(event.temperatureC),
      humidityRh: finiteOrNull(event.humidityRh),
      qcTags: Array.isArray(event.qcTags)
        ? event.qcTags.map((tag) => String(tag).trim().toUpperCase()).filter(Boolean)
        : undefined,
      statusChange: optionalString(event.statusChange)?.toUpperCase(),
      archived: Boolean(event.archived),
    };
    if (!unitCodes.has(normalized.unitCode))
      throw new Error(`Event ${normalized.id} references missing unit ${normalized.unitCode}`);
    return normalized;
  });

  const transfers = arrayOf(input.transfers, "transfers").map((transfer) => {
    const normalized = {
      id: requiredString(transfer.id, "transfer.id"),
      sourceUnitCode: requiredString(transfer.sourceUnitCode, "transfer.sourceUnitCode"),
      targetUnitCode: requiredString(transfer.targetUnitCode, "transfer.targetUnitCode"),
      transferTime: requiredDateString(transfer.transferTime, "transfer.transferTime"),
      method: optionalString(transfer.method) ?? "",
      amount: optionalString(transfer.amount) ?? "",
      description: optionalString(transfer.description),
      note: optionalString(transfer.note),
      archived: Boolean(transfer.archived),
    };
    if (!unitCodes.has(normalized.sourceUnitCode))
      throw new Error(
        `Transfer ${normalized.id} references missing source unit ${normalized.sourceUnitCode}`,
      );
    if (!unitCodes.has(normalized.targetUnitCode))
      throw new Error(
        `Transfer ${normalized.id} references missing target unit ${normalized.targetUnitCode}`,
      );
    return normalized;
  });

  return {
    strains,
    units,
    events,
    transfers,
    taxonomy: normalizeTaxonomy(input),
  };
}

function parseTrendVariableId(value) {
  const id = requiredString(value, "variableId");
  const [scope, metric, ...locationParts] = id.split(":");
  if (scope === "dl") {
    const sourceId = metric;
    const variableKey = locationParts.join(":").trim();
    if (!sourceId || !variableKey)
      throw new Error("variableId must use dl:<sourceId>:<variableKey>");
    return { scope, sourceId, variableKey };
  }
  const location = locationParts.join(":").trim().toUpperCase();
  if (scope !== "env" || !location) throw new Error("variableId must use env:<metric>:<location>");
  trendMetricSql(metric);
  return { scope, metric, location };
}

function trendMetricSql(metric) {
  if (metric === "temperatureC") return { column: "temperature_c" };
  if (metric === "humidityRh") return { column: "humidity_rh" };
  if (metric === "co2Ppm") return { column: "co2_ppm" };
  throw new Error("Unknown trend metric");
}

function trendMetricLabel(metric) {
  if (metric === "temperatureC") return "Temperature";
  if (metric === "humidityRh") return "Humidity";
  if (metric === "co2Ppm") return "CO2";
  return metric;
}

function trendMetricUnit(metric) {
  if (metric === "temperatureC") return "C";
  if (metric === "humidityRh") return "%RH";
  if (metric === "co2Ppm") return "ppm";
  return "";
}

// Aggregation buckets for /api/trends/series. Grouping uses the existing
// (source_id, variable_key, timestamp) / (location, timestamp) range indexes.
const TREND_BUCKET_SECONDS = { "5m": 300, "10m": 600, "30m": 1800, hour: 3600, "6h": 21600, day: 86400 };
function normalizeTrendBucket(value) {
  if (value === "raw" || Object.hasOwn(TREND_BUCKET_SECONDS, value)) return value;
  return "10m";
}

function normalizeTrendPreset(input) {
  if (!input || typeof input !== "object") throw new Error("JSON object is required");
  const id = optionalString(input.id) ?? `trend-${Date.now()}`;
  const viewKey = normalizeViewKey(input.viewKey);
  const name = requiredString(input.name, "preset.name").slice(0, 160);
  const layout = input.layout && typeof input.layout === "object" ? input.layout : null;
  if (!layout) throw new Error("preset.layout is required");
  if (!Array.isArray(layout.widgets)) throw new Error("preset.layout.widgets must be an array");
  return { id, viewKey, name, layout };
}

function normalizeViewKey(value) {
  const text = optionalString(value)?.toLowerCase() ?? "myko";
  if (text === "myko" || text === "plants") return text;
  throw new Error("viewKey must be myko or plants");
}

const DL_VAR_TYPES = ["analog", "status", "unused"];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function normalizeDataloggerVariablePatch(input) {
  if (!input || typeof input !== "object") throw Object.assign(new Error("JSON object is required"), { status: 400 });
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const sets = [];
  if ("prefix" in input) sets.push(["prefix", (optionalString(input.prefix) ?? "Sensor").slice(0, 80)]);
  if ("scale" in input) {
    const scale = Number(input.scale);
    if (!Number.isFinite(scale) || scale === 0) throw bad("scale must be a non-zero number");
    sets.push(["scale", scale]);
  }
  if ("unit" in input) sets.push(["unit", optionalString(input.unit)?.slice(0, 40) ?? null]);
  if ("visible" in input) sets.push(["visible", input.visible === false ? 0 : 1]);
  if ("displayName" in input) sets.push(["display_name", optionalString(input.displayName)?.slice(0, 160) ?? null]);
  if ("type" in input) {
    if (!DL_VAR_TYPES.includes(input.type)) throw bad(`type must be one of ${DL_VAR_TYPES.join(", ")}`);
    sets.push(["var_type", input.type]);
  }
  if ("bits" in input) {
    if (!Array.isArray(input.bits) || input.bits.length > 32) throw bad("bits must be an array (max 32)");
    const seen = new Set();
    const bits = input.bits.map((b) => {
      const bit = Number(b?.bit);
      if (!Number.isInteger(bit) || bit < 0 || bit > 31) throw bad("bit must be an integer 0..31");
      if (seen.has(bit)) throw bad(`bit ${bit} defined twice`);
      seen.add(bit);
      const name = optionalString(b.name)?.slice(0, 80);
      if (!name) throw bad(`bit ${bit} needs a name`);
      return {
        bit,
        name,
        ...(HEX_COLOR.test(b.onColor ?? "") ? { onColor: b.onColor.toLowerCase() } : {}),
        ...(HEX_COLOR.test(b.offColor ?? "") ? { offColor: b.offColor.toLowerCase() } : {}),
        ...(b.invert ? { invert: true } : {}),
        ...(b.alarm ? { alarm: true } : {}),
      };
    });
    bits.sort((a, b) => a.bit - b.bit);
    sets.push(["bits_json", JSON.stringify(bits)]);
  }
  return sets;
}

function normalizeStrainBody(input, options = { requireCode: true }) {
  if (!input || typeof input !== "object") throw new Error("JSON object is required");
  const code =
    input.code === undefined && !options.requireCode
      ? undefined
      : normalizeStrainCode(requiredString(input.code, "strain.code"));
  return {
    code,
    name: requiredString(input.name, "strain.name"),
    species: requiredString(input.species, "strain.species"),
    description: optionalString(input.description),
    notes: optionalString(input.notes),
    archived: Boolean(input.archived),
  };
}

function normalizeStrainCode(value) {
  return requiredString(value, "strain.code").replace(/^#+/, "").trim().toUpperCase();
}

// Units may have no strain (null); empty strings / "#" mean "no strain".
function optionalStrainCode(value) {
  if (value === null || value === undefined) return null;
  const code = String(value).replace(/^#+/, "").trim().toUpperCase();
  return code || null;
}

function normalizeUnitBody(input) {
  if (!input || typeof input !== "object") throw new Error("JSON object is required");
  return {
    type: requiredString(input.type, "unit.type").toUpperCase(),
    strainCode: optionalStrainCode(input.strainCode),
    status: requiredString(input.status, "unit.status").toUpperCase(),
    batchTime: requiredDateString(input.batchTime, "unit.batchTime"),
    parentUnitCode: optionalString(input.parentUnitCode),
    substrate: optionalString(input.substrate)?.toUpperCase(),
    currentLocation: optionalString(input.currentLocation)?.toUpperCase(),
    description: optionalString(input.description),
    notes: optionalString(input.notes),
  };
}

// Predefined lookups (taxonomy_terms): reject unknown location / substrate codes.
export async function assertLookup(conn, category, value, label) {
  if (value === null || value === undefined || value === "") return;
  const rows = await conn.query("SELECT value FROM taxonomy_terms WHERE category = ?", [category]);
  if (rows.length && !rows.some((r) => r.value === value))
    throw new Error(`Unknown ${label} ${value}; allowed: ${rows.map((r) => r.value).join(", ")}`);
}

async function assertUnitReferences(conn, code, unit) {
  await assertLookup(conn, "substrates", unit.substrate, "substrate");
  await assertLookup(conn, "locations", unit.currentLocation, "location");
  if (unit.strainCode) {
    const strainRows = await conn.query("SELECT code FROM strains WHERE code = ?", [unit.strainCode]);
    if (strainRows.length === 0) throw new Error(`Unknown strain #${unit.strainCode}`);
  }

  if (unit.parentUnitCode) {
    if (unit.parentUnitCode === code) throw new Error("Unit cannot be its own parent");
    const parentRows = await conn.query("SELECT code FROM units WHERE code = ?", [
      unit.parentUnitCode,
    ]);
    if (parentRows.length === 0) throw new Error(`Unknown parent unit ${unit.parentUnitCode}`);
  }
}

function normalizeImportMode(mode, replace) {
  if (mode === "replace" || replace === "true") return "replace";
  if (mode === "upsert" || replace === "false" || mode === undefined) return "upsert";
  throw new Error("mode must be upsert or replace");
}

function normalizeTaxonomy(input = {}) {
  const taxonomy = input.taxonomy ?? {};
  return {
    functions: uniqueUpper([...(taxonomy.functions ?? []), ...arrayValuesFrom("functionCode")]),
    types: uniqueUpper([...(taxonomy.types ?? []), ...arrayValuesFrom("type")]),
    statuses: uniqueUpper([
      ...(taxonomy.statuses ?? []),
      ...arrayValuesFrom("status"),
      ...arrayValuesFrom("statusChange"),
    ]),
    qcTags: uniqueUpper([...(taxonomy.qcTags ?? []), ...arrayValuesFrom("qcTags").flat()]),
  };

  function arrayValuesFrom(key) {
    const lists = [input.units, input.events].filter(Array.isArray);
    return lists.flatMap((items) => items.map((item) => item?.[key]).filter(Boolean));
  }
}

function arrayOf(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function requiredString(value, name) {
  const text = optionalString(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function requiredDateString(value, name) {
  const text = requiredString(value, name);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date`);
  return date.toISOString();
}

function requiredDate(value, name) {
  const date = new Date(requiredString(value, name));
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date`);
  return date;
}

function uniqueUpper(values) {
  return Array.from(
    new Set(values.map((value) => String(value).trim().toUpperCase()).filter(Boolean)),
  );
}

function parseJsonArray(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(value) {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  );
}

function boolToDb(value) {
  return value ? 1 : 0;
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function toMariaDbDateTime(date) {
  return date.toISOString().slice(0, 23).replace("T", " ");
}
