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
  // Measurement points with an external alarm checker publishing <topic_prefix>/json (2026-10-21)
  `CREATE TABLE IF NOT EXISTS alarm_points (
    id VARCHAR(80) PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    topic_prefix VARCHAR(255) NOT NULL,
    value_source VARCHAR(200) NULL,
    unit VARCHAR(40) NULL,
    bits_json JSON NULL,
    sort_order INT NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    last_status INT NULL,
    last_active JSON NULL,
    last_payload JSON NULL,
    last_message_at DATETIME(3) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_alarm_points_topic (topic_prefix)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS alarm_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    point_id VARCHAR(80) NOT NULL,
    alarm VARCHAR(40) NOT NULL,
    bit INT NULL,
    event VARCHAR(10) NOT NULL,
    at DATETIME(3) NOT NULL,
    value DOUBLE NULL,
    status_word INT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_alarm_events_point_at (point_id, at),
    CONSTRAINT fk_alarm_events_point FOREIGN KEY (point_id) REFERENCES alarm_points(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Control values owned by Myko (ON/HEAT/COOL/SP), merged into the point's published status word.
  `CREATE TABLE IF NOT EXISTS alarm_point_controls (
    point_id VARCHAR(80) PRIMARY KEY,
    on_state TINYINT(1) NOT NULL DEFAULT 1,
    heat TINYINT(1) NOT NULL DEFAULT 0,
    cool TINYINT(1) NOT NULL DEFAULT 0,
    setpoint TINYINT UNSIGNED NOT NULL DEFAULT 25,
    updated_by VARCHAR(80) NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_alarm_point_controls_point FOREIGN KEY (point_id) REFERENCES alarm_points(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // 1-min PID snapshots + outdoor temperature for ML training (safe-state / feed-forward output vs outdoor temp).
  `CREATE TABLE IF NOT EXISTS pid_training_log (
    at DATETIME NOT NULL,               -- UTC, truncated to the minute
    pid_key VARCHAR(16) NOT NULL,       -- F1 / T1 / G_Air
    sp DECIMAL(7,2) NULL, csp DECIMAL(7,2) NULL, pv DECIMAL(7,2) NULL,
    out_heat DECIMAL(7,2) NULL, out_cool DECIMAL(7,2) NULL, out_sum DECIMAL(7,2) NULL,
    state TINYINT NULL, mode TINYINT NULL, man_en TINYINT(1) NULL, err_bits INT NULL,
    outdoor_temp DECIMAL(6,2) NULL,     -- datalogger, see outdoor_tag
    outdoor_tag VARCHAR(16) NULL,
    pv_age_s INT NULL,                  -- age of the PID state snapshot when logged
    PRIMARY KEY (pid_key, at), INDEX idx_pid_training_at (at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // DeepSeek PID advisor: one row per analysis (never writes to PLC by itself).
  `CREATE TABLE IF NOT EXISTS pid_ai_analysis (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    at DATETIME NOT NULL, pid_key VARCHAR(16) NOT NULL, \`trigger\` VARCHAR(16) NOT NULL, model VARCHAR(40) NULL,
    params_json JSON NULL, input_summary JSON NULL, response_json JSON NULL,
    prompt_tokens INT NULL, completion_tokens INT NULL, duration_ms INT NULL, status VARCHAR(16) NOT NULL DEFAULT 'new',
    INDEX idx_pid_ai_pid (pid_key, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // PID_Temp parameter snapshots (before every apply) and applied/restored sets with read-back results.
  `CREATE TABLE IF NOT EXISTS pid_param_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    at DATETIME NOT NULL, pid_key VARCHAR(16) NOT NULL, kind VARCHAR(16) NOT NULL, by_user VARCHAR(40) NULL, reason VARCHAR(120) NULL,
    analysis_id BIGINT UNSIGNED NULL, params_json JSON NOT NULL, result_json JSON NULL,
    INDEX idx_pid_param_hist (pid_key, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Myko settings (JSON per key): db_myko (Safe_Output, watchdog, freeze; written to DB_Myko only when enabled), anomaly_last
  `CREATE TABLE IF NOT EXISTS myko_settings (
    k VARCHAR(40) PRIMARY KEY, v JSON NOT NULL, updated_by VARCHAR(40) NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Sensor 5 V reset requests (sent / rejected), basis for the 5 min lockout + 3 / 24 h cap
  `CREATE TABLE IF NOT EXISTS sensor_reset_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, at DATETIME NOT NULL, by_user VARCHAR(40) NULL, source VARCHAR(16) NOT NULL,
    result VARCHAR(16) NOT NULL, detail VARCHAR(500) NULL, INDEX idx_sensor_reset_at (at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // DeepSeek anomaly monitor findings (read-only advisor)
  `CREATE TABLE IF NOT EXISTS llm_findings (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, at DATETIME NOT NULL, run_id VARCHAR(32) NOT NULL, \`trigger\` VARCHAR(16) NOT NULL,
    severity VARCHAR(8) NOT NULL, point VARCHAR(40) NOT NULL, category VARCHAR(40) NOT NULL, finding TEXT NULL, suggestion TEXT NULL,
    recommend_reset TINYINT(1) NOT NULL DEFAULT 0, duplicate TINYINT(1) NOT NULL DEFAULT 0, whatsapp TINYINT(1) NULL,
    prompt_tokens INT NULL, completion_tokens INT NULL, INDEX idx_llm_findings_at (at), INDEX idx_llm_findings_pc (point, category, at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Ledger assistant: every proposed / confirmed / rejected action (source=assistant)
  `CREATE TABLE IF NOT EXISTS assistant_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, at DATETIME NOT NULL, session_id VARCHAR(40) NOT NULL, kind VARCHAR(16) NOT NULL,
    action VARCHAR(40) NULL, payload_json JSON NULL, result_json JSON NULL, operation_id VARCHAR(64) NULL, prompt_tokens INT NULL, completion_tokens INT NULL,
    INDEX idx_assistant_log_session (session_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // AI process description (processDoc.js), one row per saved version
  `CREATE TABLE IF NOT EXISTS ai_process_doc (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, at DATETIME NOT NULL, by_user VARCHAR(40) NULL, content MEDIUMTEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // PID_Temp H/C via output limits (pid.js): stored "ON" limits per PID + mode ('bits' = legacy Ctrl word bit8/9, 'limits' = Myko writes
  // Config.Output.Heat.PidUpperLimit / Config.Output.Cool.PidLowerLimit; Ctrl bits 8/9 then constant 1)
  `CREATE TABLE IF NOT EXISTS pid_output_limits (
    pid_key VARCHAR(16) NOT NULL PRIMARY KEY, heat_on DECIMAL(6,2) NOT NULL DEFAULT 100, cool_on DECIMAL(6,2) NOT NULL DEFAULT -100,
    mode VARCHAR(8) NOT NULL DEFAULT 'bits', updated_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // met.no Locationforecast (compact), one row per 30-min fetch: entry nearest the fetch time.
  `CREATE TABLE IF NOT EXISTS weather_metno (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    fetched_at DATETIME NOT NULL,          -- UTC
    forecast_time DATETIME NOT NULL,       -- UTC, timeseries entry used
    air_temperature DECIMAL(5,1) NULL, relative_humidity DECIMAL(5,1) NULL,
    cloud_area_fraction DECIMAL(5,1) NULL, wind_speed DECIMAL(5,1) NULL,
    model_updated_at DATETIME NULL, http VARCHAR(8) NULL,  -- 200 / 304 / cached
    INDEX idx_weather_metno_fetched (fetched_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const alterStatements = [
  "ALTER TABLE units MODIFY strain_code VARCHAR(80) NULL",
  "ALTER TABLE trend_presets ADD COLUMN IF NOT EXISTS view_key VARCHAR(40) NOT NULL DEFAULT 'myko' AFTER id",
  "ALTER TABLE datalogger_variables ADD COLUMN IF NOT EXISTS prefix VARCHAR(80) NOT NULL DEFAULT 'Sensor' AFTER variable_key",
  "ALTER TABLE datalogger_variables ADD COLUMN IF NOT EXISTS visible TINYINT(1) NOT NULL DEFAULT 1 AFTER scale",
  // 2026-10-21: user-editable display name (name stays the seeded sheet name), variable type, bit definitions
  "ALTER TABLE datalogger_variables ADD COLUMN IF NOT EXISTS display_name VARCHAR(160) NULL AFTER name",
  // 2026-10-22: alarm limits relative to setpoint (editable) + timed alarm disable
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS warn_delta DECIMAL(4,1) NOT NULL DEFAULT 1.5 AFTER setpoint",
  // exact (0.1 step) setpoint; `setpoint` keeps the rounded integer for the status word bits 10-14 and the checker
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS setpoint_exact DECIMAL(4,1) NULL AFTER setpoint",
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS warn_min SMALLINT UNSIGNED NOT NULL DEFAULT 30 AFTER warn_delta",
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS warn_both TINYINT(1) NOT NULL DEFAULT 1 AFTER warn_min",
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS high_delta DECIMAL(4,1) NOT NULL DEFAULT 3.0 AFTER warn_both",
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS high_min SMALLINT UNSIGNED NOT NULL DEFAULT 10 AFTER high_delta",
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS low_delta DECIMAL(4,1) NOT NULL DEFAULT 3.0 AFTER high_min",
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS low_min SMALLINT UNSIGNED NOT NULL DEFAULT 10 AFTER low_delta",
  "ALTER TABLE alarm_point_controls ADD COLUMN IF NOT EXISTS alarms_disabled_until DATETIME NULL AFTER low_min",
  "ALTER TABLE alarm_events MODIFY alarm VARCHAR(255) NOT NULL",
  "ALTER TABLE pid_ai_analysis ADD COLUMN IF NOT EXISTS user_wishes TEXT NULL",
  // hidden alarm point that owns DeepSeek monitor events (enabled=0: not shown as a point, not evaluated)
  "INSERT IGNORE INTO alarm_points (id, name, topic_prefix, enabled, sort_order) VALUES ('LLM_Advisor', 'DeepSeek-valvoja', 'Myko/LLM_Advisor', 0, 99)",
  "ALTER TABLE datalogger_variables ADD COLUMN IF NOT EXISTS var_type VARCHAR(16) NOT NULL DEFAULT 'analog' AFTER visible",
  "ALTER TABLE datalogger_variables ADD COLUMN IF NOT EXISTS bits_json JSON NULL AFTER var_type",
];

// Datalogger indices that carry status words (AlarmWord_1=16, BitsToDoSomething=18, AlarmWord_2=19;
// 13/14 reserved for new words). Applied once, when var_type is first added.
const STATUS_WORD_KEYS = ["dl13", "dl14", "dl16", "dl18", "dl19"];

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
  // Terrario 1 alarm point (checker: /home/atte/myko-ml/alarm_points_check.py), thresholds relative to setpoint SP.
  {
    sql: `INSERT IGNORE INTO alarm_points (id, name, topic_prefix, value_source, unit, bits_json, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      "Terrario1",
      "Terrario 1",
      "Myko/Alarms/Terrario1",
      "dl:src-datalogger:dl00",
      "°C",
      JSON.stringify([
        { bit: 0, key: "WARN", level: "warn", rule: "|T − SP| > 1.5 °C for 30 min" },
        { bit: 1, key: "HIGH", level: "alarm", rule: "T > SP + 3 °C for 10 min" },
        { bit: 2, key: "CRIT", level: "alarm", rule: "> 30 °C for 3 min" },
        { bit: 3, key: "LOW", level: "alarm", rule: "T < SP − 3 °C for 10 min" },
        { bit: 4, key: "COLD", level: "alarm", rule: "< 15 °C for 3 min" },
        { bit: 5, key: "FLATLINE", level: "warn", rule: "value unchanged for 15 min" },
        { bit: 6, key: "STALE", level: "warn", rule: "no data for 10 min" },
      ]),
      20,
    ],
  },
  // Kylmäsäilytystila 1 alarm point (checker: /home/atte/myko-ml/cold_alarm_check.py). INSERT IGNORE keeps user edits.
  {
    sql: `INSERT IGNORE INTO alarm_points (id, name, topic_prefix, value_source, unit, bits_json, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      "ColdStorage1",
      "Kylmäsäilytystila 1",
      "Myko/Alarms/ColdStorage1",
      "dl:src-datalogger:dl02",
      "°C",
      JSON.stringify([
        { bit: 0, key: "WARN", level: "warn", rule: "> 9 °C for 30 min" },
        { bit: 1, key: "HIGH", level: "alarm", rule: "> 11 °C for 10 min" },
        { bit: 2, key: "CRIT", level: "alarm", rule: "> 14 °C for 3 min" },
        { bit: 3, key: "LOW", level: "alarm", rule: "< 5 °C for 3 min" },
        { bit: 4, key: "FREEZE", level: "alarm", rule: "≤ 0 °C" },
        { bit: 5, key: "FLATLINE", level: "warn", rule: "value unchanged for 15 min" },
        { bit: 6, key: "STALE", level: "warn", rule: "no data for 10 min" },
      ]),
      10,
    ],
  },
  // Kasvamon ilma (G_Air PID_Temp, poistopuhallin PF-1). Parent point = controls (ON/SP) for the PID faceplate;
  // no Myko temperature checker for it (bits empty), not part of Sensors/Mykovalvomo/Ctrl (PLC word unchanged).
  {
    sql: `INSERT IGNORE INTO alarm_points (id, name, topic_prefix, value_source, unit, bits_json, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: ["GardenAir", "Kasvamo ilma", "Myko/Alarms/GardenAir", "dl:src-datalogger:dl03", "°C", "[]", 30],
  },
  {
    sql: `INSERT IGNORE INTO alarm_points (id, name, topic_prefix, value_source, unit, bits_json, sort_order)
          SELECT 'G_Air_PID', 'Kasvamo ilma · PID', 'Myko/Alarms/G_Air_PID', NULL, unit, bits_json, 31 FROM alarm_points WHERE id = 'F1_PID'`,
    params: [],
  },
  // Default controls (INSERT IGNORE: user changes persist). ColdStorage1 SP 8, Terrario1 SP 25.
  { sql: "INSERT IGNORE INTO alarm_point_controls (point_id, on_state, heat, cool, setpoint, updated_by) VALUES ('GardenAir', 1, 0, 0, 28, 'migration')", params: [] },
  { sql: "INSERT IGNORE INTO alarm_point_controls (point_id, on_state, heat, cool, setpoint, updated_by) VALUES ('ColdStorage1', 1, 0, 0, 8, 'migration')", params: [] },
  { sql: "INSERT IGNORE INTO alarm_point_controls (point_id, on_state, heat, cool, setpoint, updated_by) VALUES ('Terrario1', 1, 0, 0, 25, 'migration')", params: [] },
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
  const [hadLimits] = await query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alarm_point_controls' AND COLUMN_NAME = 'warn_delta'`,
  );
  const [hadVarType] = await query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'datalogger_variables' AND COLUMN_NAME = 'var_type'`,
  );
  for (const statement of alterStatements) {
    await query(statement);
  }
  if (Number(hadLimits?.n ?? 0) === 0) {
    // One-time per-point limit defaults (relative to setpoint); afterwards edited from the dashboard.
    await query(
      `UPDATE alarm_point_controls SET warn_delta = 1.0, warn_min = 30, warn_both = 0, high_delta = 3.0, high_min = 10,
         low_delta = 3.0, low_min = 3 WHERE point_id = 'ColdStorage1'`,
    );
    await query(
      `UPDATE alarm_point_controls SET warn_delta = 1.5, warn_min = 30, warn_both = 1, high_delta = 3.0, high_min = 10,
         low_delta = 3.0, low_min = 10 WHERE point_id = 'Terrario1'`,
    );
  }
  if (Number(hadVarType?.n ?? 0) === 0) {
    await query(
      `UPDATE datalogger_variables SET var_type = 'status', visible = 0
       WHERE source_id = 'src-datalogger' AND variable_key IN (${STATUS_WORD_KEYS.map(() => "?").join(",")})`,
      STATUS_WORD_KEYS,
    );
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
