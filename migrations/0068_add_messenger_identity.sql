-- Messenger E2EE identity keys
-- Each user owns one ECDH P-256 keypair for message E2EE.
-- The public key is stored plaintext (SPKI base64); the private key
-- (PKCS8) is AES-GCM encrypted with a key derived from the user's
-- password (PBKDF2 with a dedicated salt) so the server never sees it.

CREATE TABLE IF NOT EXISTS messenger_keys (
  user_id         TEXT PRIMARY KEY,
  public_key_spki TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,
  enc_salt        TEXT NOT NULL,
  enc_iv          TEXT NOT NULL,
  enc_version     INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messenger_keys_created ON messenger_keys(created_at);