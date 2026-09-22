-- QR device pairing columns for device_keys (docs/e2ee.md).
--
-- The table was introduced by 0091 in the same (unreleased) sprint, so it is
-- rebuilt here instead of ALTERed: SQLite cannot add a column with a
-- non-constant default, and there is no production data to preserve.
--
-- A row starts as `pending` and carries only the joiner's *public* ephemeral
-- X25519 key. It becomes `active` when an existing device approves it by
-- posting VK wrapped under an ECDH+HKDF secret — the server never sees that
-- secret, so a pending row is worthless without the joiner's private key and
-- an approved row is worthless once both ephemeral keys are discarded.

DROP TABLE IF EXISTS device_keys;

CREATE TABLE device_keys (
  id            TEXT PRIMARY KEY,               -- nanoid, shown in the joiner's QR
  user_id       TEXT NOT NULL,
  label         TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active')),
  peer_pub      TEXT NOT NULL DEFAULT '',       -- joiner's ephemeral X25519 public key (base64)
  approved_pub  TEXT NOT NULL DEFAULT '',       -- approver's ephemeral X25519 public key (base64)
  wrapped_vk    TEXT NOT NULL DEFAULT '',       -- VK wrapped under the pairing secret; '' while pending
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL DEFAULT '',       -- pending only; ISO-8601, 10 minutes after creation
  last_seen_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_keys_user_id ON device_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_device_keys_user_state ON device_keys(user_id, state);
