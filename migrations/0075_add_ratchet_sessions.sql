-- Persisted per-conversation Double Ratchet sessions (E2EE v2). The serialized
-- ratchet (which includes private keys) is wrapped client-side with the E2EE
-- KEK (AES-GCM) before being stored here, so the server never sees plaintext
-- ratchet state. Enables resume after reload and across devices.
CREATE TABLE IF NOT EXISTS messenger_ratchet_sessions (
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_enc     TEXT NOT NULL,
  session_iv      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, conversation_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ratchet_sessions_conv ON messenger_ratchet_sessions(conversation_id);
