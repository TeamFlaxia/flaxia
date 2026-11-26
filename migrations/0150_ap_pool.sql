-- Automatic federated popularity pool.
--
-- Popularity counters observed on remote instances are kept outside `posts`
-- so the federation worker can refresh them without touching the post rows.
-- Scores are derived from those counters and exposed to the ranked timeline
-- through a LEFT JOIN (a local post simply has no pool row and scores zero).

CREATE TABLE ap_pool_metrics (
  post_id TEXT PRIMARY KEY,
  instance TEXT NOT NULL,
  favourites INTEGER NOT NULL DEFAULT 0,
  reblogs INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
);

CREATE INDEX idx_ap_pool_score ON ap_pool_metrics(score DESC);
CREATE INDEX idx_ap_pool_fetched ON ap_pool_metrics(fetched_at);
CREATE INDEX idx_ap_pool_instance ON ap_pool_metrics(instance);
