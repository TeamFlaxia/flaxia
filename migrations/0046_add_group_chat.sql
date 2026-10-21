-- Group chat tables for multi-user conversations with dynamic message support

CREATE TABLE IF NOT EXISTS group_conversations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_key    TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_group_conv_created ON group_conversations(created_at);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES group_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);

CREATE TABLE IF NOT EXISTS group_messages (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  content     TEXT NOT NULL,
  gif_key     TEXT,
  payload_key TEXT,
  swf_key     TEXT,
  edited_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (group_id) REFERENCES group_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_group_messages_sender ON group_messages(sender_id);

CREATE TABLE IF NOT EXISTS group_read_states (
  user_id              TEXT NOT NULL,
  group_id             TEXT NOT NULL,
  last_read_message_id TEXT,
  unread_count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, group_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (group_id) REFERENCES group_conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_read_states_group ON group_read_states(group_id);
