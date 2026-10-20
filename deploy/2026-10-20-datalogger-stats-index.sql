-- Covering index for /api/trends/variables stats (COUNT/MIN/MAX/AVG of raw_value per variable).
-- Applied manually on Lubuntu 2026-10-20 (took ~2 min online on ~10.3M rows).
ALTER TABLE datalogger_values
  ADD INDEX idx_datalogger_values_stats (source_id, variable_key, timestamp, raw_value),
  ALGORITHM=INPLACE, LOCK=NONE;
