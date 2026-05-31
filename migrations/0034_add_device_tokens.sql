-- Device tokens table for push notifications
CREATE TABLE IF NOT EXISTS device_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  platform   TEXT NOT NULL CHECK(platform IN ('android', 'ios', 'web')),
  token      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_token ON device_tokens(token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens(user_id);
