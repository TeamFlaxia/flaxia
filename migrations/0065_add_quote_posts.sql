-- Quote posts: let a post embed a reference to another post (like a quote tweet).
ALTER TABLE posts ADD COLUMN quoted_post_id TEXT REFERENCES posts(id);

CREATE INDEX IF NOT EXISTS idx_posts_quoted_post_id ON posts(quoted_post_id);

-- Add 'quote' notification type to the notifications CHECK constraint.
-- SQLite doesn't support ALTER CONSTRAINT, so we need to recreate the table.
CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('reported', 'fresh', 'warned', 'hidden', 'ap_follow', 'ap_like', 'ap_announce', 'reply', 'mention', 'poll_ended', 'quote')),
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
