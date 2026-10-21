-- Multi-device ratchet sessions: scope persisted sessions by device_id so a
-- user's devices no longer clobber each other's Double Ratchet state (which made
-- messages from one device undecryptable on another). The client now persists
-- the full candidate list per (user, conversation, device).

-- Add the column with a placeholder for any pre-existing rows so the NOT NULL
-- constraint is satisfiable before we rebuild the primary key.
ALTER TABLE messenger_ratchet_sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT 'legacy';

-- SQLite cannot ALTER a PRIMARY KEY, so rebuild the table with device_id inside
-- the key, carrying existing rows forward (tagged 'legacy').
CREATE TABLE messenger_ratchet_sessions_new (
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  session_enc     TEXT NOT NULL,
  session_iv      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, conversation_id, device_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO messenger_ratchet_sessions_new (user_id, conversation_id, device_id, session_enc, session_iv, updated_at)
  SELECT user_id, conversation_id, device_id, session_enc, session_iv, updated_at
  FROM messenger_ratchet_sessions;

DROP TABLE messenger_ratchet_sessions;
ALTER TABLE messenger_ratchet_sessions_new RENAME TO messenger_ratchet_sessions;

CREATE INDEX IF NOT EXISTS idx_ratchet_sessions_conv ON messenger_ratchet_sessions(conversation_id);
