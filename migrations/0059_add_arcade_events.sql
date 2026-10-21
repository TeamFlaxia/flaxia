-- Raw Arcade interaction log. Unlike user_game_plays (positive dwell only),
-- this captures every rendered game including quick skips (negative signal)
-- needed for dwell-time reinforcement learning and the recommendation bandit.
CREATE TABLE IF NOT EXISTS arcade_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  event_type TEXT NOT NULL DEFAULT 'view',
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  swipe_velocity REAL NOT NULL DEFAULT 0,
  did_skip INTEGER NOT NULL DEFAULT 0,
  is_fullscreen INTEGER NOT NULL DEFAULT 0,
  game_type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_arcade_events_user_created ON arcade_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arcade_events_post_created ON arcade_events(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arcade_events_session ON arcade_events(session_id, created_at DESC);
