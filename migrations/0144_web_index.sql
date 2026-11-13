-- Common Crawl-backed web index. Documents are extracted by Crowd nodes from
-- WARC byte ranges; D1 keeps the searchable excerpt and metadata, while the
-- full extracted text lives in R2. Vectors (once enabled) live in Vectorize.

CREATE TABLE IF NOT EXISTS web_documents (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  canonical_url TEXT,
  domain        TEXT NOT NULL,
  lang          TEXT,
  title         TEXT NOT NULL DEFAULT '',
  excerpt       TEXT NOT NULL DEFAULT '',
  r2_key        TEXT,
  published_at  TEXT,
  crawl         TEXT NOT NULL,
  content_sha   TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'blocked')),
  fetched_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_web_documents_domain
  ON web_documents (domain);
CREATE INDEX IF NOT EXISTS idx_web_documents_fetched
  ON web_documents (fetched_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS web_fts USING fts5(
  title,
  excerpt,
  content = 'web_documents',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS web_documents_ai
AFTER INSERT ON web_documents
BEGIN
  INSERT INTO web_fts (rowid, title, excerpt)
  VALUES (new.rowid, new.title, new.excerpt);
END;

CREATE TRIGGER IF NOT EXISTS web_documents_ad
AFTER DELETE ON web_documents
BEGIN
  INSERT INTO web_fts (web_fts, rowid, title, excerpt)
  VALUES ('delete', old.rowid, old.title, old.excerpt);
END;

CREATE TRIGGER IF NOT EXISTS web_documents_au
AFTER UPDATE OF title, excerpt ON web_documents
WHEN old.title IS NOT new.title
  OR old.excerpt IS NOT new.excerpt
BEGIN
  INSERT INTO web_fts (web_fts, rowid, title, excerpt)
  VALUES ('delete', old.rowid, old.title, old.excerpt);
  INSERT INTO web_fts (rowid, title, excerpt)
  VALUES (new.rowid, new.title, new.excerpt);
END;

-- CDX entries waiting for a Crowd `cc-extract` task.
CREATE TABLE IF NOT EXISTS cc_queue (
  id             TEXT PRIMARY KEY,
  crawl          TEXT NOT NULL,
  url            TEXT NOT NULL,
  warc_filename  TEXT NOT NULL,
  offset         INTEGER NOT NULL,
  length         INTEGER NOT NULL,
  languages      TEXT,
  content_digest TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'submitted', 'done', 'failed', 'skipped')),
  task_id        TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_cc_queue_status
  ON cc_queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_cc_queue_task
  ON cc_queue (task_id);

-- Domains the scheduled ingestion job walks through the CDX index.
CREATE TABLE IF NOT EXISTS cc_sources (
  domain          TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_crawled_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Documents waiting for a Crowd `embed-gemma` batch.
CREATE TABLE IF NOT EXISTS embed_queue (
  doc_id     TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'submitted', 'done', 'failed')),
  task_id    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_embed_queue_status
  ON embed_queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_embed_queue_task
  ON embed_queue (task_id);
