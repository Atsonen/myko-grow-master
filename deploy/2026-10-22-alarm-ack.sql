-- Myko alarm acknowledgment (Myko only, not PLC ErrorAck): ack state stored on the 'start' event row.
ALTER TABLE alarm_events ADD COLUMN IF NOT EXISTS acked_at DATETIME(3) NULL, ADD COLUMN IF NOT EXISTS acked_by VARCHAR(80) NULL;
