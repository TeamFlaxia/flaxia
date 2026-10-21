-- Fix AES-GCM IV reuse in messenger E2EE v2 identity.
-- Previously every private field (identity sign key, identity DH key, signed
-- prekey, and all one-time prekeys) was encrypted with the SAME (KEK, IV)
-- pair, which is a nonce-reuse vulnerability for AES-GCM. We now store a
-- distinct IV per encrypted field and generate a fresh random IV per write.

ALTER TABLE messenger_identity_v2 ADD COLUMN identity_sign_priv_iv TEXT;
ALTER TABLE messenger_identity_v2 ADD COLUMN identity_dh_priv_iv   TEXT;
ALTER TABLE messenger_identity_v2 ADD COLUMN spk_priv_iv           TEXT;
ALTER TABLE messenger_opks         ADD COLUMN priv_iv              TEXT;

-- Backfill existing rows: they were encrypted under the single shared enc_iv,
-- so reuse that value as each field's own IV. This keeps old ciphertext
-- decryptable while new writes use unique IVs. The server holds no passwords,
-- so re-encrypting with fresh IVs is impossible here.
UPDATE messenger_identity_v2
  SET identity_sign_priv_iv = enc_iv,
      identity_dh_priv_iv   = enc_iv,
      spk_priv_iv           = enc_iv
  WHERE identity_sign_priv_iv IS NULL;

UPDATE messenger_opks
  SET priv_iv = (SELECT enc_iv FROM messenger_identity_v2 WHERE messenger_identity_v2.user_id = messenger_opks.user_id)
  WHERE priv_iv IS NULL;
