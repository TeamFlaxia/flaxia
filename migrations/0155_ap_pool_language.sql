-- Detected language of federated pool posts (Mastodon `status.language`).
--
-- A separate table keeps this migration replay-safe: 0151's ap_pool_metrics
-- schema is untouched, so applying the AP series twice stays a no-op.
CREATE TABLE IF NOT EXISTS ap_pool_language (
  post_id  TEXT PRIMARY KEY,
  language TEXT NOT NULL
);
