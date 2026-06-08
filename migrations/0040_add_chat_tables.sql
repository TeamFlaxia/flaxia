-- Create chat servers table
CREATE TABLE IF NOT EXISTS chat_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_key    TEXT,
  owner_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_servers_owner ON chat_servers(owner_id);

-- Create chat server members table
CREATE TABLE IF NOT EXISTS chat_server_members (
  server_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (server_id, user_id),
  FOREIGN KEY (server_id) REFERENCES chat_servers(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_server_members_user ON chat_server_members(user_id);

-- Create chat channels table
CREATE TABLE IF NOT EXISTS chat_channels (
  id        TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text','voice')),
  position  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (server_id) REFERENCES chat_servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_channels_server ON chat_channels(server_id);

-- Create chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  content     TEXT NOT NULL,
  reply_to_id TEXT,
  edited_at   TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (reply_to_id) REFERENCES chat_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created ON chat_messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);

-- Create chat message reactions table
CREATE TABLE IF NOT EXISTS chat_message_reactions (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_message_reactions_message ON chat_message_reactions(message_id);

-- Create chat read states table
CREATE TABLE IF NOT EXISTS chat_read_states (
  user_id              TEXT NOT NULL,
  channel_id           TEXT NOT NULL,
  last_read_message_id TEXT,
  unread_count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (last_read_message_id) REFERENCES chat_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_read_states_channel ON chat_read_states(channel_id);
