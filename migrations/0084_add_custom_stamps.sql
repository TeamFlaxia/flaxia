-- Custom stamps (user-defined emoji)
CREATE TABLE IF NOT EXISTS custom_stamps (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  image_key  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_custom_stamps_user ON custom_stamps(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_stamps_user_name ON custom_stamps(user_id, name);

-- Add stamp_id to message tables for stamp reactions in chat
ALTER TABLE dm_messages ADD COLUMN stamp_id TEXT;
ALTER TABLE group_messages ADD COLUMN stamp_id TEXT;
ALTER TABLE server_messages ADD COLUMN stamp_id TEXT;
