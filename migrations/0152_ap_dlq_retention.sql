-- Bounded retention for ActivityPub dead letters.
--
-- Quarantined Create activities can carry followers-only/direct `content`,
-- `to` and `cc`. The consumer now redacts private bodies before inserting
-- into ap_dlq (functions/queue-worker.ts), and the dedicated `30 4 * * *`
-- cron deletes rows older than AP_DLQ_RETENTION_DAYS (14 days).
--
-- The cutoff DELETE benefits from a covering index ordered by received_at;
-- 0150 already has a single-column index, this one also carries the primary
-- key so the prune can scan a compact index instead of the payload rows.

CREATE INDEX IF NOT EXISTS idx_ap_dlq_received_at_id ON ap_dlq(received_at, id);
