-- File security scanning: per-upload scan state + the shared blocklist.
--
-- Every uploaded object gets one file_scans row holding the features extracted
-- synchronously in the Worker (sha256, zip entry-list hash, pdf text hash,
-- image phash) plus the asynchronous ClamAV verdict delivered by the Crowd
-- orchestrator callback (status: pending -> submitted -> clean|infected|
-- failed|skipped).
--
-- The status CHECK is duplicated verbatim in FILE_SCANS_SCHEMA in
-- functions/lib/scan/db.ts (the runtime bootstrap for databases created
-- outside the migration path). SQLite cannot ALTER a CHECK constraint: if a
-- database already holds a file_scans built from an older copy of this file,
-- drop both tables here (or rebuild them) before re-running migrations.
--
-- file_blocklist is the admin-curated deny list. Entries match by exact value
-- for sha256/structure_hash/text_hash/signature, and by hamming distance for
-- phash (compared in JS: SQLite has no popcount and the table stays small).
CREATE TABLE file_scans (
  r2_key         TEXT PRIMARY KEY,
  sha256         TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'other'
    CHECK(kind IN ('image', 'zip', 'pdf', 'video', 'audio', 'other')),
  structure_hash TEXT,
  text_hash      TEXT,
  -- One 16-hex-char hash, or a comma-separated list for video keyframes.
  phash          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'submitted', 'clean', 'infected', 'failed', 'skipped')),
  -- ClamAV signature name when infected, or the skip/failure reason.
  detail         TEXT,
  task_id        TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scanned_at     TEXT
);

CREATE INDEX idx_file_scans_sha256 ON file_scans(sha256);
CREATE INDEX idx_file_scans_status ON file_scans(status, created_at);

CREATE TABLE file_blocklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL
    CHECK(kind IN ('sha256', 'structure_hash', 'text_hash', 'phash', 'signature')),
  value      TEXT NOT NULL,
  signature  TEXT,
  reason     TEXT,
  added_by   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(kind, value)
);

CREATE INDEX idx_file_blocklist_kind ON file_blocklist(kind);
