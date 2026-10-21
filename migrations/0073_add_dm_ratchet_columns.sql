-- Messenger E2EE v2: ratchet header columns for DM messages.
-- content holds the AEAD ciphertext; the ratchet header (sender ratchet
-- public key + chain counters) is needed by the receiver's Double Ratchet.

ALTER TABLE dm_messages ADD COLUMN ratchet_pub TEXT;
ALTER TABLE dm_messages ADD COLUMN ratchet_pn INTEGER;
ALTER TABLE dm_messages ADD COLUMN ratchet_n INTEGER;
