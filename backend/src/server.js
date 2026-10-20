import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { query, withConnection } from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3010);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5199";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "50mb" }));

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

app.post("/api/unit-locations", async (req, res) => {
  const body = req.body ?? {};
  if (!body.unitCode || !body.location)
    return res.status(400).json({ error: "unitCode and location are required" });
  const movedAt = body.movedAt ? new Date(body.movedAt) : new Date();
  const result = await query(
    `INSERT INTO unit_locations (unit_code, location, moved_at, note)
     VALUES (?, ?, ?, ?)`,
    [
      String(body.unitCode),
      String(body.location).toUpperCase(),
      toMariaDbDateTime(movedAt),
      body.note ?? null,
    ],
  );
  res.status(201).json({ id: Number(result.insertId) });
});

app.get(
  "/api/trends/variables",
  asyncRoute(async (_req, res) => {
    const [environmentRows, dataloggerRows] = await Promise.all([
      query(
        `SELECT
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
     ORDER BY location, metric`,
      ),
      query(
        `SELECT
           v.source_id,
           v.position,
           v.variable_key,
           v.prefix,
           v.name,
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
         WHERE v.visible = 1
         GROUP BY v.source_id, v.position, v.variable_key, v.prefix, v.name, v.unit, v.scale
         ORDER BY v.position`,
      ),
    ]);
    res.json([
      ...environmentRows.map(mapEnvironmentTrendVariable),
      ...dataloggerRows.map(mapDataloggerTrendVariable),
    ]);
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
        bucket === "day"
          ? "DATE_FORMAT(dv.timestamp, '%Y-%m-%d 00:00:00')"
          : "DATE_FORMAT(dv.timestamp, '%Y-%m-%d %H:00:00')";
      const timestampExpr =
        bucket === "day"
          ? "CONCAT(DATE_FORMAT(dv.timestamp, '%Y-%m-%d'), 'T00:00:00Z')"
          : "CONCAT(DATE_FORMAT(dv.timestamp, '%Y-%m-%dT%H'), ':00:00Z')";
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
      bucket === "day"
        ? "DATE_FORMAT(timestamp, '%Y-%m-%d 00:00:00')"
        : "DATE_FORMAT(timestamp, '%Y-%m-%d %H:00:00')";
    const timestampExpr =
      bucket === "day"
        ? "CONCAT(DATE_FORMAT(timestamp, '%Y-%m-%d'), 'T00:00:00Z')"
        : "CONCAT(DATE_FORMAT(timestamp, '%Y-%m-%dT%H'), ':00:00Z')";
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
      `SELECT source_id, position, variable_key, prefix, name, unit, scale, visible, archived, description
       FROM datalogger_variables
       ORDER BY source_id, position`,
    );
    res.json(rows.map(mapDataloggerVariable));
  }),
);

app.put(
  "/api/datalogger/variables/:sourceId/:variableKey",
  asyncRoute(async (req, res) => {
    const sourceId = requiredString(req.params.sourceId, "sourceId");
    const variableKey = requiredString(req.params.variableKey, "variableKey");
    const body = normalizeDataloggerVariablePatch(req.body);
    await query(
      `UPDATE datalogger_variables
       SET prefix = ?, scale = ?, unit = ?, visible = ?
       WHERE source_id = ? AND variable_key = ?`,
      [body.prefix, body.scale, body.unit, boolToDb(body.visible), sourceId, variableKey],
    );
    const rows = await query(
      `SELECT source_id, position, variable_key, prefix, name, unit, scale, visible, archived, description
       FROM datalogger_variables
       WHERE source_id = ? AND variable_key = ?`,
      [sourceId, variableKey],
    );
    if (rows.length === 0) return res.status(404).json({ error: "Datalogger variable not found" });
    res.json(mapDataloggerVariable(rows[0]));
  }),
);

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

        await conn.query(
          `UPDATE units
         SET type = ?, strain_code = ?, status = ?, batch_time = ?, parent_unit_code = ?,
             substrate = ?, current_location = ?, description = ?, notes = ?
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
    sampleCount: Number(row.sample_count),
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
    sampleCount: Number(row.sample_count),
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
  return {
    sourceId: row.source_id,
    position: Number(row.position),
    variableKey: row.variable_key,
    prefix: row.prefix ?? "Sensor",
    name: row.name,
    unit: row.unit ?? "",
    scale: Number(row.scale),
    visible: Boolean(row.visible),
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
    strainCode: row.strain_code,
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
  const taxonomy = { functions: [], types: [], statuses: [], qcTags: [] };
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
      strainCode: requiredString(unit.strainCode, "unit.strainCode")
        .replace(/^#+/, "")
        .trim()
        .toUpperCase(),
      status: requiredString(unit.status, "unit.status").toUpperCase(),
      batchTime: requiredDateString(unit.batchTime, "unit.batchTime"),
      parentUnitCode: optionalString(unit.parentUnitCode),
      substrate: optionalString(unit.substrate),
      currentLocation: optionalString(unit.currentLocation),
      description: optionalString(unit.description),
      notes: optionalString(unit.notes),
    };
    if (!strainCodes.has(normalized.strainCode))
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

function normalizeTrendBucket(value) {
  if (value === "raw" || value === "hour" || value === "day") return value;
  return "hour";
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

function normalizeDataloggerVariablePatch(input) {
  if (!input || typeof input !== "object") throw new Error("JSON object is required");
  const scale = Number(input.scale);
  if (!Number.isFinite(scale)) throw new Error("scale must be a number");
  return {
    prefix: (optionalString(input.prefix) ?? "Sensor").slice(0, 80),
    scale,
    unit: optionalString(input.unit)?.slice(0, 40) ?? null,
    visible: input.visible !== false,
  };
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

function normalizeUnitBody(input) {
  if (!input || typeof input !== "object") throw new Error("JSON object is required");
  return {
    type: requiredString(input.type, "unit.type").toUpperCase(),
    strainCode: normalizeStrainCode(input.strainCode),
    status: requiredString(input.status, "unit.status").toUpperCase(),
    batchTime: requiredDateString(input.batchTime, "unit.batchTime"),
    parentUnitCode: optionalString(input.parentUnitCode),
    substrate: optionalString(input.substrate)?.toUpperCase(),
    currentLocation: optionalString(input.currentLocation)?.toUpperCase(),
    description: optionalString(input.description),
    notes: optionalString(input.notes),
  };
}

async function assertUnitReferences(conn, code, unit) {
  const strainRows = await conn.query("SELECT code FROM strains WHERE code = ?", [unit.strainCode]);
  if (strainRows.length === 0) throw new Error(`Unknown strain #${unit.strainCode}`);

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
