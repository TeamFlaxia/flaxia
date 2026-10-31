-- Reservation metadata only (content fingerprint, issue URL, expiry). Report
-- text, diagnostics and screenshots never enter D1. The scheduled backend
-- worker deletes expired rows; per-user cleanup also runs before each insert.
-- D1 serializes the reservation insert and its per-user quota check.
CREATE TABLE IF NOT EXISTS bug_report_submissions (
  user_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  window_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'created')),
  expires_at INTEGER NOT NULL,
  issue_number INTEGER,
  issue_url TEXT,
  PRIMARY KEY (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_bug_report_submissions_quota
  ON bug_report_submissions (user_id, window_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_bug_report_submissions_expiry
  ON bug_report_submissions (expires_at);
