-- Call tables for voice/video calls (DM & group)

CREATE TABLE IF NOT EXISTS calls (
  id            TEXT PRIMARY KEY,
  conversation_id TEXT,
  group_id      TEXT,
  initiator_id  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ringing'
    CHECK(status IN ('ringing','active','ended','missed')),
  type          TEXT NOT NULL DEFAULT 'audio'
    CHECK(type IN ('audio','video')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at      TEXT,
  FOREIGN KEY (initiator_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_calls_conversation ON calls(conversation_id);
CREATE INDEX IF NOT EXISTS idx_calls_group ON calls(group_id);
CREATE INDEX IF NOT EXISTS idx_calls_initiator ON calls(initiator_id);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);

CREATE TABLE IF NOT EXISTS call_participants (
  call_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at   TEXT,
  muted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (call_id, user_id),
  FOREIGN KEY (call_id) REFERENCES calls(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_call_participants_call ON call_participants(call_id);
