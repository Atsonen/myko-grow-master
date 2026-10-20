-- Traceability model (2026-10-20). Idempotent; apply as a privileged user (triggers).
-- 1) Origins: a unit has 1..n origins. Each is either a parent unit (UNIT) or a non-unit source.
CREATE TABLE IF NOT EXISTS unit_origins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  unit_code VARCHAR(120) NOT NULL,
  origin_type VARCHAR(20) NOT NULL,            -- UNIT | SPORES | PURCHASED | STRAIN_LIBRARY | OTHER | UNKNOWN
  parent_unit_code VARCHAR(120) NULL,          -- set when origin_type = UNIT
  note TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_origins_unit (unit_code),
  KEY idx_origins_parent (parent_unit_code),
  UNIQUE KEY uq_origin (unit_code, origin_type, parent_unit_code),
  CONSTRAINT fk_origins_unit FOREIGN KEY (unit_code) REFERENCES units(code) ON UPDATE CASCADE,
  CONSTRAINT fk_origins_parent FOREIGN KEY (parent_unit_code) REFERENCES units(code) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Hide = visibility flag, independent of status and never a delete.
ALTER TABLE units ADD COLUMN IF NOT EXISTS hidden TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE units ADD COLUMN IF NOT EXISTS hidden_at DATETIME(3) NULL;
-- 3) Bulk operations: events created together share an operation id.
ALTER TABLE events ADD COLUMN IF NOT EXISTS operation_id VARCHAR(80) NULL;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_events_operation (operation_id);
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_events_unit_time (unit_code, event_time);

-- 4) Immutable audit log, filled by triggers so every write path (API, scripts, SQL) is recorded.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME(3) NOT NULL DEFAULT UTC_TIMESTAMP(3),
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(160) NOT NULL,
  unit_code VARCHAR(120) NULL,
  action VARCHAR(20) NOT NULL,                 -- INSERT | UPDATE | DELETE
  changed_fields VARCHAR(400) NULL,
  before_json LONGTEXT NULL,
  after_json LONGTEXT NULL,
  actor VARCHAR(80) NULL,
  operation_id VARCHAR(80) NULL,
  KEY idx_audit_unit (unit_code, at),
  KEY idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER //
DROP TRIGGER IF EXISTS audit_log_no_update//
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'//
DROP TRIGGER IF EXISTS audit_log_no_delete//
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'//

-- units
DROP TRIGGER IF EXISTS trg_units_ai//
CREATE TRIGGER trg_units_ai AFTER INSERT ON units FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, after_json, actor, operation_id)
  VALUES ('unit', NEW.code, NEW.code, 'INSERT', JSON_OBJECT('code',NEW.code,'type',NEW.type,'strain_code',NEW.strain_code,'status',NEW.status,
    'batch_time',NEW.batch_time,'parent_unit_code',NEW.parent_unit_code,'substrate',NEW.substrate,'current_location',NEW.current_location,
    'description',NEW.description,'notes',NEW.notes,'hidden',NEW.hidden), COALESCE(@myko_actor,'db'), @myko_op)//
DROP TRIGGER IF EXISTS trg_units_au//
CREATE TRIGGER trg_units_au AFTER UPDATE ON units FOR EACH ROW
BEGIN
  DECLARE f VARCHAR(400) DEFAULT '';
  IF NOT (OLD.type <=> NEW.type) THEN SET f = CONCAT(f,'type,'); END IF;
  IF NOT (OLD.strain_code <=> NEW.strain_code) THEN SET f = CONCAT(f,'strain_code,'); END IF;
  IF NOT (OLD.status <=> NEW.status) THEN SET f = CONCAT(f,'status,'); END IF;
  IF NOT (OLD.batch_time <=> NEW.batch_time) THEN SET f = CONCAT(f,'batch_time,'); END IF;
  IF NOT (OLD.parent_unit_code <=> NEW.parent_unit_code) THEN SET f = CONCAT(f,'parent_unit_code,'); END IF;
  IF NOT (OLD.substrate <=> NEW.substrate) THEN SET f = CONCAT(f,'substrate,'); END IF;
  IF NOT (OLD.current_location <=> NEW.current_location) THEN SET f = CONCAT(f,'current_location,'); END IF;
  IF NOT (OLD.description <=> NEW.description) THEN SET f = CONCAT(f,'description,'); END IF;
  IF NOT (OLD.notes <=> NEW.notes) THEN SET f = CONCAT(f,'notes,'); END IF;
  IF NOT (OLD.hidden <=> NEW.hidden) THEN SET f = CONCAT(f,'hidden,'); END IF;
  IF f <> '' THEN
    INSERT INTO audit_log (entity_type, entity_id, unit_code, action, changed_fields, before_json, after_json, actor, operation_id)
    VALUES ('unit', NEW.code, NEW.code, 'UPDATE', TRIM(TRAILING ',' FROM f),
      JSON_OBJECT('type',OLD.type,'strain_code',OLD.strain_code,'status',OLD.status,'batch_time',OLD.batch_time,'parent_unit_code',OLD.parent_unit_code,
        'substrate',OLD.substrate,'current_location',OLD.current_location,'description',OLD.description,'notes',OLD.notes,'hidden',OLD.hidden),
      JSON_OBJECT('type',NEW.type,'strain_code',NEW.strain_code,'status',NEW.status,'batch_time',NEW.batch_time,'parent_unit_code',NEW.parent_unit_code,
        'substrate',NEW.substrate,'current_location',NEW.current_location,'description',NEW.description,'notes',NEW.notes,'hidden',NEW.hidden),
      COALESCE(@myko_actor,'db'), @myko_op);
  END IF;
END//
DROP TRIGGER IF EXISTS trg_units_ad//
CREATE TRIGGER trg_units_ad AFTER DELETE ON units FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, before_json, actor, operation_id)
  VALUES ('unit', OLD.code, OLD.code, 'DELETE', JSON_OBJECT('code',OLD.code,'type',OLD.type,'strain_code',OLD.strain_code,'status',OLD.status,
    'batch_time',OLD.batch_time,'parent_unit_code',OLD.parent_unit_code,'current_location',OLD.current_location,'notes',OLD.notes), COALESCE(@myko_actor,'db'), @myko_op)//

-- unit_locations (moves; "archive" of a move is an UPDATE)
DROP TRIGGER IF EXISTS trg_loc_ai//
CREATE TRIGGER trg_loc_ai AFTER INSERT ON unit_locations FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, after_json, actor, operation_id)
  VALUES ('location', NEW.id, NEW.unit_code, 'INSERT', JSON_OBJECT('location',NEW.location,'moved_at',NEW.moved_at,'note',NEW.note), COALESCE(@myko_actor,'db'), @myko_op)//
DROP TRIGGER IF EXISTS trg_loc_au//
CREATE TRIGGER trg_loc_au AFTER UPDATE ON unit_locations FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, before_json, after_json, actor, operation_id)
  VALUES ('location', NEW.id, NEW.unit_code, 'UPDATE', JSON_OBJECT('location',OLD.location,'moved_at',OLD.moved_at,'archived',OLD.archived),
    JSON_OBJECT('location',NEW.location,'moved_at',NEW.moved_at,'archived',NEW.archived), COALESCE(@myko_actor,'db'), @myko_op)//
DROP TRIGGER IF EXISTS trg_loc_ad//
CREATE TRIGGER trg_loc_ad AFTER DELETE ON unit_locations FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, before_json, actor, operation_id)
  VALUES ('location', OLD.id, OLD.unit_code, 'DELETE', JSON_OBJECT('location',OLD.location,'moved_at',OLD.moved_at), COALESCE(@myko_actor,'db'), @myko_op)//

-- unit_origins
DROP TRIGGER IF EXISTS trg_org_ai//
CREATE TRIGGER trg_org_ai AFTER INSERT ON unit_origins FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, after_json, actor, operation_id)
  VALUES ('origin', NEW.id, NEW.unit_code, 'INSERT', JSON_OBJECT('origin_type',NEW.origin_type,'parent_unit_code',NEW.parent_unit_code,'note',NEW.note), COALESCE(@myko_actor,'db'), @myko_op)//
DROP TRIGGER IF EXISTS trg_org_ad//
CREATE TRIGGER trg_org_ad AFTER DELETE ON unit_origins FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, before_json, actor, operation_id)
  VALUES ('origin', OLD.id, OLD.unit_code, 'DELETE', JSON_OBJECT('origin_type',OLD.origin_type,'parent_unit_code',OLD.parent_unit_code,'note',OLD.note), COALESCE(@myko_actor,'db'), @myko_op)//

-- events
DROP TRIGGER IF EXISTS trg_evt_ai//
CREATE TRIGGER trg_evt_ai AFTER INSERT ON events FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, after_json, actor, operation_id)
  VALUES ('event', NEW.id, NEW.unit_code, 'INSERT', JSON_OBJECT('function_code',NEW.function_code,'event_time',NEW.event_time,'title',NEW.title,
    'status_change',NEW.status_change,'operation_id',NEW.operation_id), COALESCE(@myko_actor,'db'), COALESCE(NEW.operation_id,@myko_op))//
DROP TRIGGER IF EXISTS trg_evt_au//
CREATE TRIGGER trg_evt_au AFTER UPDATE ON events FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, before_json, after_json, actor, operation_id)
  VALUES ('event', NEW.id, NEW.unit_code, 'UPDATE',
    JSON_OBJECT('function_code',OLD.function_code,'event_time',OLD.event_time,'title',OLD.title,'note',OLD.note,'status_change',OLD.status_change,'archived',OLD.archived),
    JSON_OBJECT('function_code',NEW.function_code,'event_time',NEW.event_time,'title',NEW.title,'note',NEW.note,'status_change',NEW.status_change,'archived',NEW.archived),
    COALESCE(@myko_actor,'db'), @myko_op)//
DROP TRIGGER IF EXISTS trg_evt_ad//
CREATE TRIGGER trg_evt_ad AFTER DELETE ON events FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, before_json, actor, operation_id)
  VALUES ('event', OLD.id, OLD.unit_code, 'DELETE', JSON_OBJECT('function_code',OLD.function_code,'event_time',OLD.event_time,'title',OLD.title), COALESCE(@myko_actor,'db'), @myko_op)//

-- transfers
DROP TRIGGER IF EXISTS trg_trf_ai//
CREATE TRIGGER trg_trf_ai AFTER INSERT ON transfers FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, after_json, actor, operation_id)
  VALUES ('transfer', NEW.id, NEW.target_unit_code, 'INSERT', JSON_OBJECT('source',NEW.source_unit_code,'target',NEW.target_unit_code,
    'transfer_time',NEW.transfer_time,'method',NEW.method,'amount',NEW.amount), COALESCE(@myko_actor,'db'), @myko_op)//
DROP TRIGGER IF EXISTS trg_trf_au//
CREATE TRIGGER trg_trf_au AFTER UPDATE ON transfers FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, before_json, after_json, actor, operation_id)
  VALUES ('transfer', NEW.id, NEW.target_unit_code, 'UPDATE',
    JSON_OBJECT('source',OLD.source_unit_code,'target',OLD.target_unit_code,'transfer_time',OLD.transfer_time,'archived',OLD.archived),
    JSON_OBJECT('source',NEW.source_unit_code,'target',NEW.target_unit_code,'transfer_time',NEW.transfer_time,'archived',NEW.archived), COALESCE(@myko_actor,'db'), @myko_op)//
DROP TRIGGER IF EXISTS trg_trf_ad//
CREATE TRIGGER trg_trf_ad AFTER DELETE ON transfers FOR EACH ROW
  INSERT INTO audit_log (entity_type, entity_id, unit_code, action, before_json, actor, operation_id)
  VALUES ('transfer', OLD.id, OLD.target_unit_code, 'DELETE', JSON_OBJECT('source',OLD.source_unit_code,'target',OLD.target_unit_code), COALESCE(@myko_actor,'db'), @myko_op)//
DELIMITER ;

-- 5) Backfill origins once (from parent_unit_code and transfer sources) - only if table is empty.
SET @myko_actor = 'migration-backfill';
INSERT IGNORE INTO unit_origins (unit_code, origin_type, parent_unit_code, note)
  SELECT u.code, 'UNIT', u.parent_unit_code, 'Backfilled from units.parent_unit_code'
  FROM units u WHERE u.parent_unit_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unit_origins);
INSERT IGNORE INTO unit_origins (unit_code, origin_type, parent_unit_code, note)
  SELECT DISTINCT t.target_unit_code, 'UNIT', t.source_unit_code, 'Backfilled from transfers'
  FROM transfers t JOIN units s ON s.code = t.source_unit_code JOIN units d ON d.code = t.target_unit_code
  WHERE t.archived = 0 AND t.source_unit_code <> t.target_unit_code
    AND NOT EXISTS (SELECT 1 FROM unit_origins o WHERE o.note <> 'Backfilled from units.parent_unit_code' AND o.note <> 'Backfilled from transfers');
SET @myko_actor = NULL;
