-- Durable retry queue for Flaxia Mail account deletion (docs/mail.md §11.3).
-- The Mail data lives in a separate D1/R2 behind MAIL_SERVICE; if that service
-- is unavailable when the account is deleted, the scheduled backend worker
-- retries from this outbox until the Mail Worker confirms the purge.
CREATE TABLE IF NOT EXISTS mail_deletion_outbox (
  user_id     TEXT PRIMARY KEY NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_checked TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_mail_deletion_outbox_checked
  ON mail_deletion_outbox(last_checked);
