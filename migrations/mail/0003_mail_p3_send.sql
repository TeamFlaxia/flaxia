-- P3 send (docs/mail.md §9.2, §9.3).
--
-- Internal E2EE mail fans out to one message row per mailbox. The client seals
-- metadata, subject, payload, and attachments with the logical message id bound
-- into the AEAD AAD, so every copy stores that logical id in `aad_id`. Readers
-- use `aad_id` when present and fall back to the row id for inbound mail.
--
-- Attachments also record their AES-GCM IV: the blob itself stays pure
-- ciphertext in R2, while the row carries the IV (and the logical attachment id
-- in `aad_id`, used as the HKDF input).
ALTER TABLE mail_messages ADD COLUMN aad_id TEXT NOT NULL DEFAULT '';
ALTER TABLE mail_attachments ADD COLUMN aad_id TEXT NOT NULL DEFAULT '';
ALTER TABLE mail_attachments ADD COLUMN iv TEXT NOT NULL DEFAULT '';
