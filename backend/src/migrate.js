import dotenv from "dotenv";
import { closeDb, query } from "./db.js";

dotenv.config();

const statements = [
  `CREATE TABLE IF NOT EXISTS environment_sources (
    id VARCHAR(80) PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    location VARCHAR(160) NOT NULL,
    mqtt_topic VARCHAR(255),
    description TEXT,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS environment_channel_map (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_id VARCHAR(80) NOT NULL,
    payload_key VARCHAR(80) NOT NULL,
    alias VARCHAR(80) NOT NULL,
    location VARCHAR(160) NOT NULL,
    metric ENUM('temperatureC','humidityRh','co2Ppm') NOT NULL,
    description TEXT,
    UNIQUE KEY uq_source_payload_metric (source_id, payload_key, metric),
    CONSTRAINT fk_channel_source FOREIGN KEY (source_id) REFERENCES environment_sources(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS environment_readings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    timestamp DATETIME(3) NOT NULL,
    location VARCHAR(160) NOT NULL,
    source VARCHAR(160) NOT NULL,
    mqtt_topic VARCHAR(255),
    payload_key VARCHAR(80),
    alias VARCHAR(80),
    temperature_c DECIMAL(7,3),
    humidity_rh DECIMAL(7,3),
    co2_ppm DECIMAL(10,2),
    raw_payload JSON,
    note TEXT,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_readings_location_timestamp (location, timestamp),
    INDEX idx_readings_timestamp (timestamp),
    INDEX idx_readings_source (source)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS unit_locations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    unit_code VARCHAR(120) NOT NULL,
    location VARCHAR(160) NOT NULL,
    moved_at DATETIME(3) NOT NULL,
    note TEXT,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_unit_locations_unit_moved (unit_code, moved_at),
    INDEX idx_unit_locations_location_moved (location, moved_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS strains (
    code VARCHAR(80) PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    species VARCHAR(160) NOT NULL,
    description TEXT,
    notes TEXT,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS units (
    code VARCHAR(120) PRIMARY KEY,
    type VARCHAR(40) NOT NULL,
    strain_code VARCHAR(80) NULL,
    status VARCHAR(40) NOT NULL,
    batch_time DATETIME(3) NOT NULL,
    parent_unit_code VARCHAR(120),
    substrate VARCHAR(160),
    current_location VARCHAR(160),
    description TEXT,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_units_strain (strain_code),
    INDEX idx_units_parent (parent_unit_code),
    INDEX idx_units_status (status),
    CONSTRAINT fk_units_strain FOREIGN KEY (strain_code) REFERENCES strains(code) ON UPDATE CASCADE,
    CONSTRAINT fk_units_parent FOREIGN KEY (parent_unit_code) REFERENCES units(code) ON DELETE SET NULL ON UPDATE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(80) PRIMARY KEY,
    function_code VARCHAR(40) NOT NULL,
    unit_code VARCHAR(120) NOT NULL,
    event_time DATETIME(3) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    note TEXT,
    temperature_c DECIMAL(7,3),
    humidity_rh DECIMAL(7,3),
    qc_tags JSON,
    status_change VARCHAR(40),
    archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_events_unit_time (unit_code, event_time),
    INDEX idx_events_function_time (function_code, event_time),
    CONSTRAINT fk_events_unit FOREIGN KEY (unit_code) REFERENCES units(code) ON UPDATE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS transfers (
    id VARCHAR(80) PRIMARY KEY,
    source_unit_code VARCHAR(120) NOT NULL,
    target_unit_code VARCHAR(120) NOT NULL,
    transfer_time DATETIME(3) NOT NULL,
    method VARCHAR(160) NOT NULL,
    amount VARCHAR(160) NOT NULL,
    description TEXT,
    note TEXT,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_transfers_source_time (source_unit_code, transfer_time),
    INDEX idx_transfers_target_time (target_unit_code, transfer_time),
    CONSTRAINT fk_transfers_source FOREIGN KEY (source_unit_code) REFERENCES units(code) ON UPDATE CASCADE,
    CONSTRAINT fk_transfers_target FOREIGN KEY (target_unit_code) REFERENCES units(code) ON UPDATE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS taxonomy_terms (
    category VARCHAR(40) NOT NULL,
    value VARCHAR(120) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (category, value)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS dashboard_layouts (
    id VARCHAR(80) PRIMARY KEY,
    layout_json JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS trend_presets (
    id VARCHAR(80) PRIMARY KEY,
    view_key VARCHAR(40) NOT NULL DEFAULT 'myko',
    name VARCHAR(160) NOT NULL,
    layout_json JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_trend_presets_view_updated (view_key, updated_at),
    INDEX idx_trend_presets_updated (updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS datalogger_variables (
    source_id VARCHAR(80) NOT NULL,
    position INT UNSIGNED NOT NULL,
    variable_key VARCHAR(120) NOT NULL,
    prefix VARCHAR(80) NOT NULL DEFAULT 'Sensor',
    name VARCHAR(160) NOT NULL,
    unit VARCHAR(40),
    scale DECIMAL(12,6) NOT NULL DEFAULT 1,
    visible TINYINT(1) NOT NULL DEFAULT 1,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (source_id, position),
    UNIQUE KEY uq_datalogger_variable_key (source_id, variable_key),
    INDEX idx_datalogger_variables_visible (visible),
    INDEX idx_datalogger_variables_archived (archived)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS datalogger_samples (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    timestamp DATETIME(3) NOT NULL,
    source_id VARCHAR(80) NOT NULL,
    mqtt_topic VARCHAR(255),
    raw_payload JSON,
    raw_text MEDIUMTEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_datalogger_samples_source_timestamp (source_id, timestamp),
    INDEX idx_datalogger_samples_timestamp (timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS datalogger_values (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sample_id BIGINT UNSIGNED NOT NULL,
    timestamp DATETIME(3) NOT NULL,
    source_id VARCHAR(80) NOT NULL,
    position INT UNSIGNED NOT NULL,
    variable_key VARCHAR(120) NOT NULL,
    variable_name VARCHAR(160) NOT NULL,
    raw_value DECIMAL(18,6) NOT NULL,
    numeric_value DECIMAL(18,6) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_datalogger_values_variable_timestamp (source_id, variable_key, timestamp),
    INDEX idx_datalogger_values_sample (sample_id),
    CONSTRAINT fk_datalogger_values_sample FOREIGN KEY (sample_id) REFERENCES datalogger_samples(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const alterStatements = [
  "ALTER TABLE units MODIFY strain_code VARCHAR(80) NULL",
  "ALTER TABLE trend_presets ADD COLUMN IF NOT EXISTS view_key VARCHAR(40) NOT NULL DEFAULT 'myko' AFTER id",
  "ALTER TABLE datalogger_variables ADD COLUMN IF NOT EXISTS prefix VARCHAR(80) NOT NULL DEFAULT 'Sensor' AFTER variable_key",
  "ALTER TABLE datalogger_variables ADD COLUMN IF NOT EXISTS visible TINYINT(1) NOT NULL DEFAULT 1 AFTER scale",
];

const dataloggerVariables = [
  { name: "T1 Temp", unit: "C", scale: 0.01 },
  { name: "Vapaa", archived: true },
  { name: "F1 Temp", unit: "C", scale: 0.01 },
  { name: "G Mid DS2", unit: "C", scale: 0.01 },
  { name: "PF-1 %", unit: "%", scale: 0.01 },
  { name: "WaterTemp", unit: "C", scale: 0.01 },
  { name: "Vapaa", archived: true },
  { name: "Vapaa", archived: true },
  { name: "Vapaa", archived: true },
  { name: "G1 temp TT", unit: "C", scale: 0.01 },
  { name: "Vapaa", archived: true },
  { name: "Multiple" },
  { name: "Sterilointi?" },
  { name: "13" },
  { name: "14" },
  { name: "G1 HUM", unit: "%RH", scale: 0.01 },
  { name: "AlarmWord_1" },
  { name: "T3 Hum", unit: "%RH", scale: 0.01 },
  { name: "BitsToDoSomething" },
  { name: "AlarmWord_2" },
  { name: "T3 Temp", unit: "C", scale: 0.01 },
  { name: "G Temp AHT", unit: "C", scale: 0.01 },
  { name: "G Humidity", unit: "%RH", scale: 0.01 },
  { name: "ppm", unit: "ppm" },
  { name: "Water Temp", unit: "C", scale: 0.01 },
  { name: "Level", unit: "%", scale: 0.01 },
  { name: "pH", unit: "pH", scale: 0.01 },
  { name: "temp", unit: "C", scale: 0.01 },
  { name: "rTds" },
  { name: "rTdsRaw" },
  { name: "G Katto DS3", unit: "C", scale: 0.01 },
  { name: "G Poistoilma DS4", unit: "C", scale: 0.01 },
  { name: "pH RAw" },
  { name: "33" },
  { name: "34" },
  { name: "35" },
  { name: "36" },
  { name: "37" },
  { name: "38" },
  { name: "39" },
];

const seedStatements = [
  // Event function INOC (inoculation) added 2026-10-20
  { sql: "INSERT IGNORE INTO taxonomy_terms (category, value) VALUES ('functions', 'INOC')", params: [] },
  // Predefined locations and substrates (dropdowns; backend rejects unknown codes) – 2026-10-20
  { sql: "INSERT IGNORE INTO taxonomy_terms (category, value) VALUES ('locations','KYLMASAILYTYSTILA-1'),('locations','TERRARIO-1'),('locations','TERRARIO-2'),('locations','GARDEN')", params: [] },
  { sql: "INSERT IGNORE INTO taxonomy_terms (category, value) VALUES ('substrates','BR'),('substrates','BULK'),('substrates','FCR'),('substrates','GRAIN'),('substrates','OAT'),('substrates','RICE')", params: [] },
  {
    sql: `INSERT INTO environment_sources (id, name, location, mqtt_topic, description)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE name=VALUES(name), location=VALUES(location), mqtt_topic=VALUES(mqtt_topic), description=VALUES(description)`,
    params: [
      "src-sensorblock-1",
      "SensorBlock 1",
      "SENSORBLOCK-1",
      "Sensors/SensorBlock_1",
      "Internal MQTT JSON payload. DStemp1=F1/Kylmäsäilytystila 1, DStemp2=T1/Terrario 1.",
    ],
  },
  {
    sql: `INSERT INTO environment_channel_map (source_id, payload_key, alias, location, metric, description)
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE alias=VALUES(alias), location=VALUES(location), description=VALUES(description)`,
    params: [
      "src-sensorblock-1",
      "DStemp1",
      "F1",
      "KYLMASAILYTYSTILA-1",
      "temperatureC",
      "Kylmäsäilytystila 1 temperature sensor.",
    ],
  },
  {
    sql: `INSERT INTO environment_channel_map (source_id, payload_key, alias, location, metric, description)
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE alias=VALUES(alias), location=VALUES(location), description=VALUES(description)`,
    params: [
      "src-sensorblock-1",
      "DStemp2",
      "T1",
      "TERRARIO-1",
      "temperatureC",
      "Terrario 1 temperature sensor.",
    ],
  },
];

for (const [position, variable] of dataloggerVariables.entries()) {
  seedStatements.push({
    sql: `INSERT INTO datalogger_variables
            (source_id, position, variable_key, prefix, name, unit, scale, visible, archived, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            variable_key=VALUES(variable_key),
            name=VALUES(name),
            archived=VALUES(archived),
            description=VALUES(description)`,
    params: [
      "src-datalogger",
      position,
      `dl${String(position).padStart(2, "0")}`,
      "Sensor",
      variable.name,
      variable.unit ?? null,
      variable.scale ?? 1,
      1,
      variable.archived ? 1 : 0,
      `Datalogger index ${position}`,
    ],
  });
}

async function main() {
  console.log("Running MariaDB migrations...");
  for (const statement of statements) {
    await query(statement);
  }
  for (const statement of alterStatements) {
    await query(statement);
  }
  for (const seed of seedStatements) {
    await query(seed.sql, seed.params);
  }
  console.log("Migrations complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
