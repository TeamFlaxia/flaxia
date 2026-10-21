-- NudeNet screening progress for posts/replies with image attachments.
-- Tracks which posts have been submitted to the crowd detector and their
-- outcome, so backfills can skip already-scanned posts (idempotent) and the
-- screening status can be audited per post.
CREATE TABLE IF NOT EXISTS post_nsfw_scans (
  post_id     TEXT PRIMARY KEY,
  task_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'submitted'
    CHECK(status IN ('submitted', 'done', 'failed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scanned_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_nsfw_scans_status ON post_nsfw_scans(status, created_at);