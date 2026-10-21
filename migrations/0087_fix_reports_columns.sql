-- Migration: repair the reports table schema.
--
-- 0006 created `reports` with a `reason` column and a CHECK constraint.
-- 0008/0009 (which would have migrated it to `category` + DMCA + status) were
-- renamed to `.skip`, so the application (routes/report.ts) writes columns that
-- never existed. Rebuild the table in place, preserving existing rows.

ALTER TABLE reports RENAME TO reports_legacy;

CREATE TABLE reports (
  id                      TEXT PRIMARY KEY,
  post_id                 TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  category                TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending',
  dmca_work_description   TEXT,
  dmca_reporter_email     TEXT,
  dmca_sworn              INTEGER DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (post_id, user_id)
);

INSERT INTO reports (id, post_id, user_id, category, status, dmca_work_description, dmca_reporter_email, dmca_sworn, created_at)
SELECT
  id,
  post_id,
  user_id,
  COALESCE(reason, 'other'),
  'pending',
  NULL,
  NULL,
  0,
  created_at
FROM reports_legacy;

DROP TABLE reports_legacy;

CREATE INDEX IF NOT EXISTS idx_reports_post_category ON reports(post_id, category);
