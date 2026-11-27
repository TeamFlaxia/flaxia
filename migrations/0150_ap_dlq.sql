-- ActivityPub dead-letter durability.
--
-- Cloudflare Queues keeps a message in a dead-letter queue for a limited time
-- (four days by default). A delivery that failed because of a data problem is
-- worth keeping longer than that: persist every dead letter in D1 so an
-- operator can inspect the payload and the failure reason and redrive it after
-- fixing the root cause.

CREATE TABLE IF NOT EXISTS ap_dlq (
  id          TEXT PRIMARY KEY,
  queue       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  error       TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ap_dlq_received_at ON ap_dlq(received_at);
CREATE INDEX IF NOT EXISTS idx_ap_dlq_queue ON ap_dlq(queue);
