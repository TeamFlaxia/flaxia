-- Verify new email addresses before granting access or activating changes.
-- Existing users are grandfathered as verified; newly inserted users leave the
-- nullable timestamp empty until the single-use confirmation token is consumed.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
UPDATE users
SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'email_change')),
  user_id TEXT NOT NULL,
  candidate_email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_email_verification_user_purpose
  ON email_verification_tokens(user_id, purpose);
CREATE INDEX idx_email_verification_expiry
  ON email_verification_tokens(expires_at);
CREATE INDEX idx_email_verification_candidate
  ON email_verification_tokens(candidate_email, purpose, expires_at);
