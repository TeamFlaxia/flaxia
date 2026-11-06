-- Flaxia Mail schema (docs/mail.md §7). Lives in the separate MAIL_DB D1
-- database, never in the main `flaxia` database. User identity is the
-- Auth-owned Flaxia user id; address provisioning is checked through the
-- Pages proxy before any row is created here.
--
-- All display data (subjects, names, label names, bodies) is ciphertext.
-- The server stores only wrapped blobs and routing metadata.

CREATE TABLE IF NOT EXISTS mail_addresses (
  address     TEXT PRIMARY KEY, -- lowercase local@flaxia.app
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary', 'alias')),
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  disabled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mail_addresses_user ON mail_addresses(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_addresses_primary
  ON mail_addresses(user_id) WHERE kind = 'primary';

CREATE TABLE IF NOT EXISTS mail_identities (
  user_id     TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  public_key  TEXT NOT NULL, -- P-256 SPKI base64
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mail_identity_versions (
  user_id     TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  public_key  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, key_version)
);

CREATE TABLE IF NOT EXISTS mail_threads (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  subject_enc      TEXT NOT NULL,
  last_message_at  TEXT NOT NULL,
  message_count    INTEGER NOT NULL DEFAULT 1,
  unread_count     INTEGER NOT NULL DEFAULT 0,
  participants_enc TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_mail_threads_user ON mail_threads(user_id, last_message_at);

CREATE TABLE IF NOT EXISTS mail_messages (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  thread_id           TEXT NOT NULL REFERENCES mail_threads(id),
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound','internal','draft')),
  folder              TEXT NOT NULL CHECK (folder IN ('inbox','sent','drafts','archive','spam','trash')),
  from_addr           TEXT NOT NULL,
  to_addr             TEXT NOT NULL DEFAULT '',
  from_name_enc       TEXT NOT NULL DEFAULT '',
  to_enc              TEXT NOT NULL DEFAULT '',
  cc_enc              TEXT NOT NULL DEFAULT '',
  bcc_enc             TEXT NOT NULL DEFAULT '',
  reply_to_enc        TEXT NOT NULL DEFAULT '',
  subject_enc         TEXT NOT NULL DEFAULT '',
  meta_enc            TEXT NOT NULL DEFAULT '',
  message_id_hash     TEXT NOT NULL DEFAULT '',
  in_reply_to_hash    TEXT NOT NULL DEFAULT '',
  references_hash     TEXT NOT NULL DEFAULT '',
  sent_at             TEXT,
  received_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  size_bytes          INTEGER NOT NULL DEFAULT 0,
  has_attachments     INTEGER NOT NULL DEFAULT 0,
  read_at             TEXT,
  starred_at          TEXT,
  security            TEXT NOT NULL CHECK (security IN ('e2ee','at_rest','tls')),
  auth_results        TEXT NOT NULL DEFAULT '{}',
  spam_score          REAL NOT NULL DEFAULT 0,
  blob_id             TEXT NOT NULL DEFAULT '',
  raw_blob_key        TEXT NOT NULL DEFAULT '',
  deleted_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_user_folder
  ON mail_messages(user_id, folder, received_at);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id, received_at);

CREATE TABLE IF NOT EXISTS mail_message_keys (
  message_id             TEXT NOT NULL REFERENCES mail_messages(id),
  recipient_address      TEXT NOT NULL,
  key_version            INTEGER NOT NULL DEFAULT 1,
  ephemeral_public_key   TEXT NOT NULL,
  iv                     TEXT NOT NULL,
  wrapped_content_key    TEXT NOT NULL,
  PRIMARY KEY (message_id, recipient_address)
);

CREATE TABLE IF NOT EXISTS mail_blobs (
  id           TEXT PRIMARY KEY,
  r2_key       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  ref_count    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES mail_messages(id),
  user_id      TEXT NOT NULL,
  filename_enc TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  r2_key       TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  scan_status  TEXT NOT NULL DEFAULT 'pending',
  cid_enc      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_mail_attachments_message ON mail_attachments(message_id);

CREATE TABLE IF NOT EXISTS mail_labels (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name_enc   TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#6b7280',
  system     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mail_message_labels (
  message_id TEXT NOT NULL REFERENCES mail_messages(id),
  label_id   TEXT NOT NULL REFERENCES mail_labels(id),
  user_id    TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);

CREATE TABLE IF NOT EXISTS mail_usage (
  user_id          TEXT PRIMARY KEY,
  storage_bytes    INTEGER NOT NULL DEFAULT 0,
  external_sends   INTEGER NOT NULL DEFAULT 0,
  external_day     TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mail_ingest_jobs (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mail_outbound_jobs (
  id                 TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL DEFAULT '',
  user_id            TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL DEFAULT 'pending',
  provider_message_id TEXT NOT NULL DEFAULT '',
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mail_deletion_jobs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mail_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'new_mail',
  cursor      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_mail_events_user ON mail_events(user_id, created_at);

-- Deleted addresses stay reserved for 90 days to prevent misdirected mail
-- and impersonation (docs/mail.md §11.3).
CREATE TABLE IF NOT EXISTS mail_reserved_addresses (
  address     TEXT PRIMARY KEY,
  reserved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  release_at  TEXT NOT NULL
);
