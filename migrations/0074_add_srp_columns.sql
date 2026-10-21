-- Add SRP (Secure Remote Password) verifier columns to users so the account
-- password never reaches the server in plaintext, yet can derive the E2EE KEK
-- client-side. Legacy password_hash is kept for fallback / dual-mode login.
ALTER TABLE users ADD COLUMN srp_salt TEXT;
ALTER TABLE users ADD COLUMN srp_verifier TEXT;
ALTER TABLE users ADD COLUMN srp_group TEXT DEFAULT '2048';

-- Ephemeral SRP server state kept between /login/start and /login/verify.
-- SQLite is case-insensitive for unquoted identifiers, so `b` and `B` would
-- collide; we name them explicitly instead.
CREATE TABLE IF NOT EXISTS srp_handshakes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  b_scalar   TEXT NOT NULL,
  b_pub      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_srp_handshakes_expires ON srp_handshakes(expires_at);
