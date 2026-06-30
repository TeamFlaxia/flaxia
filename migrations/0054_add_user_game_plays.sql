CREATE TABLE IF NOT EXISTS user_game_plays (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  is_fullscreen INTEGER NOT NULL DEFAULT 0,
  game_type TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'arcade',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ugp_user ON user_game_plays(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugp_post ON user_game_plays(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugp_user_post ON user_game_plays(user_id, post_id);
