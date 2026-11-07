-- Multi-source external feed (arXiv + Hacker News).
-- External items are stored separately from `posts`: posts have a 200-char
-- CHECK, a mandatory local user, and flow into trust scoring, embeddings,
-- and ActivityPub. External items must not enter any of those pipelines.

CREATE TABLE external_sources (
  source            TEXT PRIMARY KEY CHECK (source IN ('arxiv', 'hackernews')),
  label             TEXT NOT NULL,
  feed_url          TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_fetched_at   TEXT,
  last_status       INTEGER
);

CREATE TABLE external_items (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL REFERENCES external_sources(source),
  external_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL,
  author        TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',
  publish_at    TEXT NOT NULL,
  fetched_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, external_id)
);

CREATE INDEX idx_external_items_source_publish
  ON external_items(source, publish_at DESC);
CREATE INDEX idx_external_items_publish
  ON external_items(publish_at DESC);

INSERT INTO external_sources (source, label, feed_url, enabled) VALUES
  ('arxiv', 'arXiv', 'https://export.arxiv.org/api/query?search_query=cat:%2A&sortBy=submittedDate&sortOrder=descending&max_results=200', 1),
  ('hackernews', 'Hacker News', 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=200', 1);
