-- Invite links for Discord-style chat servers.
-- A token grants membership (optionally with a role) without an admin manually
-- adding the user by ID. The token carries no E2EE key material: channel keys
-- are distributed client-side (see messenger-store reconcileChannelKeys), so the
-- server never sees plaintext channel keys.

CREATE TABLE IF NOT EXISTS server_invites (
  token       TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  max_uses    INTEGER,
  use_count   INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (server_id) REFERENCES server_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_server_invites_server ON server_invites(server_id);
