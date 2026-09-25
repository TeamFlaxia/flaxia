-- Multiple media attachments (image/audio/video) per post.
-- Game payloads (zip/swf/html) keep using the legacy single-key columns.
CREATE TABLE post_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_post_attachments_post ON post_attachments(post_id, position);
