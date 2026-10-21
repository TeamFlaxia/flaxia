-- Create DM (direct message) tables for 1-on-1 private messaging

CREATE TABLE IF NOT EXISTS dm_conversations (
  id                    TEXT PRIMARY KEY,
  user_a_id             TEXT NOT NULL,
  user_b_id             TEXT NOT NULL,
  last_message_id       TEXT,
  last_message_content  TEXT,
  last_message_sender_id TEXT,
  last_message_created_at TEXT,
  user_a_read_at        TEXT,
  user_b_read_at        TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_a_id, user_b_id),
  FOREIGN KEY (user_a_id) REFERENCES users(id),
  FOREIGN KEY (user_b_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_dm_conv_user_a ON dm_conversations(user_a_id);
CREATE INDEX IF NOT EXISTS idx_dm_conv_user_b ON dm_conversations(user_b_id);

CREATE TABLE IF NOT EXISTS dm_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages(conversation_id, created_at);

-- Add dm type to notifications check constraint if needed (for future use)
