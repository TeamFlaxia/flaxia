-- Drop the legacy single shared `enc_iv` column from messenger_identity_v2.
-- Migration 0076 replaced it with per-field IV columns
-- (identity_sign_priv_iv, identity_dh_priv_iv, spk_priv_iv). The PUT
-- /api/messenger/identity-v2 endpoint never writes enc_iv anymore, so the
-- NOT NULL constraint broke fresh identity inserts. enc_iv is no longer read
-- or written anywhere for this table.

ALTER TABLE messenger_identity_v2 DROP COLUMN enc_iv;
