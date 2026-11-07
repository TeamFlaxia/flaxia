-- P2 receive/read support (docs/mail.md §7, §9).
--
-- mail_threads gains a denormalized folder (the folder of its latest message)
-- and the HMAC thread key used for subject fallback threading.
ALTER TABLE mail_threads ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox';
ALTER TABLE mail_threads ADD COLUMN thread_key TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_mail_threads_user_folder
  ON mail_threads(user_id, folder, last_message_at);
CREATE INDEX IF NOT EXISTS idx_mail_threads_thread_key
  ON mail_threads(user_id, thread_key);

-- Look up a thread by the Message-ID hash of any of its messages.
CREATE INDEX IF NOT EXISTS idx_mail_messages_user_message_id
  ON mail_messages(user_id, message_id_hash);
