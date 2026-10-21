-- Fix X3DH OPK handling: the prekey-bundle endpoint must RESERVE an OPK
-- (so it is not handed to another initiator) but must NOT delete it. The OPK
-- private material must remain on the server until the responder consumes it
-- via POST /api/messenger/opks/consume. Previously GET deleted the OPK, which
-- made every received DM fail to decrypt with "invalid tag" (the responder
-- could never recover the OPK private for the X3DH DH4 step).

ALTER TABLE messenger_opks ADD COLUMN claimed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_messenger_opks_unclaimed ON messenger_opks(user_id, claimed_at);
