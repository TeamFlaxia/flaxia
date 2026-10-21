-- Persisted materialized user interest profile used by the Arcade
-- recommendation serving path. Storing it lets the recommender avoid
-- re-deriving the weighted interest vector on every request.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  interest_vec TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_updated ON user_profiles(updated_at DESC);
