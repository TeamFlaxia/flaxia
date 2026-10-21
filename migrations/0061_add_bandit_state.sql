-- Per-user LinUCB bandit state used by the Arcade dwell-time recommender.
-- a_inv holds the inverse of the regularized design matrix (flat JSON), b the
-- reward accumulators, t the number of updates.
CREATE TABLE IF NOT EXISTS bandit_state (
  user_id TEXT PRIMARY KEY,
  a_inv TEXT NOT NULL,
  b TEXT NOT NULL,
  t INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_bandit_state_updated ON bandit_state(updated_at DESC);
