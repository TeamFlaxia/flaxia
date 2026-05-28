-- Migration 0031: Add ap_following table for remote following and actor_id to posts
CREATE TABLE IF NOT EXISTS ap_following (
  id TEXT PRIMARY KEY,
  local_user_id TEXT NOT NULL REFERENCES users(id),
  target_actor_url TEXT NOT NULL,
  target_inbox_url TEXT NOT NULL,
  target_username TEXT,
  target_domain TEXT,
  remote_actor_json TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(local_user_id, target_actor_url)
);

ALTER TABLE posts ADD COLUMN actor_id TEXT;
