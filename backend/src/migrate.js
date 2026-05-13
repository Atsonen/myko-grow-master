import dotenv from "dotenv";
import { closeDb, query } from "./db.js";

dotenv.config();

const statements = [
  `CREATE TABLE IF NOT EXISTS strains (
    code VARCHAR(80) PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    species VARCHAR(160),
    description TEXT,
    notes TEXT,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    raw_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS units (
    code VARCHAR(120) PRIMARY KEY,
    type VARCHAR(40) NOT NULL,
    strain_code VARCHAR(80) NOT NULL,
    status VARCHAR(40) NOT NULL,
    batch_time DATETIME(3) NOT NULL,
    parent_unit_code VARCHAR(120),
    substrate VARCHAR(80),
    current_location VARCHAR(160),
    description TEXT,
    notes TEXT,
    raw_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_units_strain (strain_code),
    INDEX idx_units_status (status),
    INDEX idx_units_type (type),
    INDEX idx_units_batch (batch_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS cultivation_events (
    id VARCHAR(120) PRIMARY KEY,
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
    raw_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_events_unit_time (unit_code, event_time),
    INDEX idx_events_time (event_time),
    INDEX idx_events_function (function_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS transfers (
    id VARCHAR(120) PRIMARY KEY,
    source_unit_code VARCHAR(120) NOT NULL,
    target_unit_code VARCHAR(120) NOT NULL,
    transfer_time DATETIME(3) NOT NULL,
    method VARCHAR(160),
    amount VARCHAR(160),
    description TEXT,
    note TEXT,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    raw_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_transfers_source_time (source_unit_code, transfer_time),
    INDEX idx_transfers_target_time (target_unit_code, transfer_time),
    INDEX idx_transfers_time (transfer_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS taxonomy_entries (
    category VARCHAR(80) NOT NULL,
    value VARCHAR(160) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    raw_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (category, value)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

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
];

const seedStatements = [
  {
    sql: `INSERT INTO environment_sources (id, name, location, mqtt_topic, description)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE name=VALUES(name), location=VALUES(location), mqtt_topic=VALUES(mqtt_topic), description=VALUES(description)`,
    params: [
      "src-sensorblock-1",
      "SensorBlock 1",
      "SENSORBLOCK-1",
      "Sensors/SensorBlock_1",
      "Internal MQTT JSON payload. Channel mapping is controlled in environment_channel_map.",
    ],
  },
  {
    sql: `INSERT INTO environment_channel_map (source_id, payload_key, alias, location, metric, description)
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE alias=alias`,
    params: ["src-sensorblock-1", "DStemp1", "T1", "TERRARIO-1", "temperatureC", "Default temperature sensor mapping."],
  },
  {
    sql: `INSERT INTO environment_channel_map (source_id, payload_key, alias, location, metric, description)
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE alias=alias`,
    params: ["src-sensorblock-1", "DStemp2", "F1", "KYLMASAILYTYSTILA-1", "temperatureC", "Default temperature sensor mapping."],
  },
];

async function main() {
  console.log("Running MariaDB migrations...");
  for (const statement of statements) {
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
