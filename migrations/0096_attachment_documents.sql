-- PDF attachments (kind = 'document').
--
-- SQLite cannot ALTER a CHECK constraint, so post_attachments is rebuilt with
-- the widened kind allowlist: the new table is created, rows are copied over,
-- and the old table is dropped.
--
-- Foreign keys: D1 enforces FKs on by default, and SQLite ignores PRAGMA
-- foreign_keys changes inside a transaction, so the PRAGMA lines below may be
-- no-ops depending on how the migration is applied. The rebuild is safe either
-- way: post_attachments is a child table (nothing references it), so dropping
-- it cannot cascade anywhere, and the rows are copied before the drop.
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
