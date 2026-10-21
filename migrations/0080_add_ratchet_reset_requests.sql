-- Peer "re-establish secure session" signal for E2EE v2 DMs.
-- When a participant cannot decrypt the peer's messages (e.g. their ratchet
-- session was lost / never established), they request the peer to re-bootstrap
-- X3DH. The requester stores a single row per conversation; the peer, on its
-- next poll, sees `requested = true` (requested_by != self), resets its own
-- local session, and clears the request. This makes "Reset secure session"
-- recover BOTH sides automatically instead of requiring manual coordination.
CREATE TABLE IF NOT EXISTS messenger_ratchet_reset_requests (
  conversation_id TEXT NOT NULL PRIMARY KEY,
  requested_by    TEXT NOT NULL,
  requested_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
