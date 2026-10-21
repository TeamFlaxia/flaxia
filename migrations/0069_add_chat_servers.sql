-- Discord-style chat servers for the messaging feature.
-- Message content is stored as E2EE ciphertext only (see E2EE columns on
-- server_messages / dm_messages / group_messages). The server never sees
-- plaintext; per-channel AES keys are wrapped per-member and stored in
-- server_channel_keys.

CREATE TABLE IF NOT EXISTS server_conversations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_key    TEXT,
  owner_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_server_conv_owner ON server_conversations(owner_id);

CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at   TEXT,
  PRIMARY KEY (server_id, user_id),
  FOREIGN KEY (server_id) REFERENCES server_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);
CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id);

CREATE TABLE IF NOT EXISTS server_channels (
  id         TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  category   TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (server_id) REFERENCES server_conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_channels_server ON server_channels(server_id);

CREATE TABLE IF NOT EXISTS server_messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  content_iv  TEXT,
  enc_version INTEGER,
  key_version INTEGER,
  reply_to_id TEXT,
  edited_at   TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  gif_key     TEXT,
  payload_key TEXT,
  swf_key     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (channel_id) REFERENCES server_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_server_messages_channel ON server_messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_server_messages_sender ON server_messages(sender_id);

-- Per-member wrapped channel keys. Each (channel, key_version, user) row holds
-- the channel's AES-256 key encrypted to that user's ECDH public key.
CREATE TABLE IF NOT EXISTS server_channel_keys (
  channel_id  TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrapped_iv  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (channel_id, key_version, user_id),
  FOREIGN KEY (channel_id) REFERENCES server_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_channel_keys_user ON server_channel_keys(user_id);

-- Read states per channel per member
CREATE TABLE IF NOT EXISTS server_read_states (
  user_id       TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  last_read_message_id TEXT,
  unread_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (channel_id) REFERENCES server_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_read_states_channel ON server_read_states(channel_id);