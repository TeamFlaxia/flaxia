-- Replay guard for Crowd webhook deliveries signed with
-- X-Flaxia-Signature/Timestamp/Nonce. Each nonce is accepted exactly once;
-- rows are deleted once the timestamp tolerance window has elapsed.
CREATE TABLE IF NOT EXISTS crowd_webhook_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crowd_webhook_nonces_expiry
  ON crowd_webhook_nonces (expires_at);
