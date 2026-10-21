-- Messenger E2EE v2: forward-secret identity (X3DH + Double Ratchet)
-- Each user owns:
--   * an Ed25519 identity signing key (signs the signed prekey)
--   * an X25519 identity DH key (used in X3DH DH steps)
--   * a signed X25519 prekey (SPK) + signature
--   * a pool of one-time X25519 prekeys (OPKs), each consumed once
-- Private material is AES-GCM encrypted with a key derived from the user's
-- password (PBKDF2) so the server never sees plaintext private keys.

CREATE TABLE IF NOT EXISTS messenger_identity_v2 (
  user_id             TEXT PRIMARY KEY,
  identity_sign_pub   TEXT NOT NULL,
  identity_sign_priv_enc TEXT NOT NULL,
  identity_dh_pub     TEXT NOT NULL,
  identity_dh_priv_enc TEXT NOT NULL,
  spk_pub             TEXT NOT NULL,
  spk_priv_enc        TEXT NOT NULL,
  spk_sig             TEXT NOT NULL,
  spk_rotated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  enc_salt            TEXT NOT NULL,
  enc_iv              TEXT NOT NULL,
  enc_version         INTEGER NOT NULL DEFAULT 2,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messenger_opks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  pub         TEXT NOT NULL,
  priv_enc    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messenger_opks_user ON messenger_opks(user_id);
