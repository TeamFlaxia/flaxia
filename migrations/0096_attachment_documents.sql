-- PDF attachments (kind = 'document').
--
-- SQLite cannot ALTER a CHECK constraint, so post_attachments is rebuilt with
-- the widened kind allowlist. The new table is created, copied into, and the
-- old one dropped inside a transaction; foreign keys are off by default on the
-- migration connection, so the DROP cannot cascade-delete attachment rows.
PRAGMA foreign_keys = OFF;

CREATE TABLE post_attachments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'document')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO post_attachments_new (id, post_id, r2_key, kind, position, created_at)
SELECT id, post_id, r2_key, kind, position, created_at FROM post_attachments;

DROP TABLE post_attachments;

ALTER TABLE post_attachments_new RENAME TO post_attachments;

CREATE INDEX idx_post_attachments_post ON post_attachments(post_id, position);

PRAGMA foreign_keys = ON;
