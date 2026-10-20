-- Applied manually on Lubuntu 2026-10-20.
-- 1) Covering index for per-unit environment curves and /api/environment/latest
--    (location, archived=0, timestamp range); ~4 s online on ~445k rows.
ALTER TABLE environment_readings
  ADD INDEX idx_readings_loc_arch_ts_values (location, archived, timestamp, temperature_c, humidity_rh),
  ALGORITHM=INPLACE, LOCK=NONE;

-- 2) One-off backfill: units.current_location := latest non-archived unit_locations row.
UPDATE units u
JOIN (
  SELECT ul.unit_code, ul.location FROM unit_locations ul
  WHERE ul.archived = 0 AND ul.id = (
    SELECT x.id FROM unit_locations x WHERE x.unit_code = ul.unit_code AND x.archived = 0
    ORDER BY x.moved_at DESC, x.id DESC LIMIT 1)
) l ON l.unit_code = u.code
SET u.current_location = l.location, u.updated_at = u.updated_at;
