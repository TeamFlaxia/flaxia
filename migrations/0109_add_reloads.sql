-- Reload is Flaxia's retweet: a local user re-shares a post to their followers.
-- Reload rows reuse the existing `shares` table (local rows have user_id set,
-- remote ActivityPub Announces have actor_id set). The denormalized counter
-- lives on posts so feeds do not need to aggregate `shares` per request.
ALTER TABLE posts ADD COLUMN reload_count INTEGER NOT NULL DEFAULT 0;

UPDATE posts
SET reload_count = (
  SELECT COUNT(*) FROM shares WHERE shares.post_id = posts.id
);

CREATE INDEX IF NOT EXISTS idx_shares_post_user ON shares(post_id, user_id);

-- Add the 'reload' notification type to the notifications CHECK constraint.
-- SQLite does not support ALTER CONSTRAINT, so the table is recreated.
CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('reported', 'fresh', 'warned', 'hidden', 'ap_follow', 'ap_like', 'ap_announce', 'reply', 'mention', 'poll_ended', 'quote', 'reload')),
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
CREATE INDEX IF NOT EXISTS idx_notifications_user_post_type
  ON notifications(user_id, post_id, type);
