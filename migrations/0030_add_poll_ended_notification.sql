-- Migration: Add ended_notified column to polls + poll_ended notification type

ALTER TABLE polls ADD COLUMN ended_notified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('reported', 'fresh', 'warned', 'hidden', 'ap_follow', 'ap_like', 'ap_announce', 'reply', 'mention', 'poll_ended')),
  post_id    TEXT,
  actor_id   TEXT,
  actor_data TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO notifications_new
SELECT id, user_id, type, post_id, actor_id, actor_data, read, created_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, created_at DESC);
