-- Per-participant KEK-wrapped plaintext backup for DM messages.
--
-- The Double Ratchet is forward-only, so a consumed message key can never be
-- recomputed. To let a user read their DM history on a NEW device (where no
-- ratchet session exists), each participant stores their OWN copy of the
-- decrypted plaintext, encrypted with their password-derived KEK. The KEK never
-- leaves the client, so the server cannot read the content. One row per
-- (message, user) because each user's KEK is distinct.

CREATE TABLE IF NOT EXISTS dm_message_plaintext (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  enc        TEXT NOT NULL,
  iv         TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_plaintext_msg ON dm_message_plaintext(message_id);
CREATE INDEX IF NOT EXISTS idx_dm_plaintext_user ON dm_message_plaintext(user_id);
