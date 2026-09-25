-- One NSFW scan row per media object instead of one per post.
--
-- A post can carry up to 4 image attachments, but post_nsfw_scans was keyed on
-- post_id alone, so only the first image of a multi-image post could ever be
-- tracked or screened. Rows written before this migration are attributed to
-- the post's legacy gif_key when that key is an image (the key the old submit
-- path used), and to '' otherwise.
CREATE TABLE post_nsfw_scans_new (
  post_id     TEXT NOT NULL,
  media_key   TEXT NOT NULL DEFAULT '',
  task_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'submitted'
    CHECK(status IN ('submitted', 'done', 'failed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scanned_at  TEXT,
  PRIMARY KEY (post_id, media_key)
);

INSERT INTO post_nsfw_scans_new (post_id, media_key, task_id, status, created_at, scanned_at)
SELECT
  s.post_id,
  CASE
    WHEN p.gif_key IS NULL THEN ''
    WHEN lower(p.gif_key) LIKE '%.png' THEN p.gif_key
    WHEN lower(p.gif_key) LIKE '%.jpg' THEN p.gif_key
    WHEN lower(p.gif_key) LIKE '%.jpeg' THEN p.gif_key
    WHEN lower(p.gif_key) LIKE '%.webp' THEN p.gif_key
    WHEN lower(p.gif_key) LIKE '%.gif' THEN p.gif_key
    ELSE ''
  END,
  s.task_id,
  s.status,
  s.created_at,
  s.scanned_at
FROM post_nsfw_scans s
LEFT JOIN posts p ON p.id = s.post_id;

DROP TABLE post_nsfw_scans;

ALTER TABLE post_nsfw_scans_new RENAME TO post_nsfw_scans;

CREATE INDEX IF NOT EXISTS idx_nsfw_scans_status ON post_nsfw_scans(status, created_at);
