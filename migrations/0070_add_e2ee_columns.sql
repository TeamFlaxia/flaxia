-- E2EE columns for existing DM and group chat.
-- Existing rows keep content plaintext (enc_version NULL). New rows store
-- base64 AES-GCM ciphertext in `content` with the nonce/version alongside.

ALTER TABLE dm_messages ADD COLUMN content_iv TEXT;
ALTER TABLE dm_messages ADD COLUMN enc_version INTEGER;
ALTER TABLE dm_messages ADD COLUMN key_version INTEGER;

ALTER TABLE dm_conversations ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE group_messages ADD COLUMN content_iv TEXT;
ALTER TABLE group_messages ADD COLUMN enc_version INTEGER;
ALTER TABLE group_messages ADD COLUMN key_version INTEGER;

ALTER TABLE group_conversations ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;

-- Per-member wrapped group keys (mirror of server_channel_keys for groups).
CREATE TABLE IF NOT EXISTS group_channel_keys (
  group_id    TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrapped_iv  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, key_version, user_id),
  FOREIGN KEY (group_id) REFERENCES group_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_channel_keys_user ON group_channel_keys(user_id);