-- Outbox for vector-embed submissions. `embedPost` used to silently drop posts
-- when rate-limited (10s), when CROWD_API_KEY was missing, or on submission
-- failure, which left the recommended feed frozen on stale candidates.
-- This table persists such posts so a drain (and the admin backfill API) can
-- retry them later instead of losing them.
CREATE TABLE IF NOT EXISTS pending_embeddings (
  post_id     TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_embeddings_created ON pending_embeddings(created_at);
