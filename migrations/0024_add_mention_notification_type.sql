-- Migration: Add mention notification type to existing constraint
-- Update the notifications table CHECK constraint to include 'mention'

-- SQLite doesn't support ALTER CONSTRAINT, so we need to recreate the table
CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('reported', 'fresh', 'warned', 'hidden', 'ap_follow', 'ap_like', 'ap_announce', 'reply', 'mention')),
  post_id    TEXT,
  actor_id   TEXT,
  actor_data TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Copy data from old table
INSERT INTO notifications_new 
SELECT id, user_id, type, post_id, actor_id, actor_data, read, created_at 
FROM notifications;

-- Drop old table
DROP TABLE notifications;

-- Rename new table
ALTER TABLE notifications_new RENAME TO notifications;

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, created_at DESC);
