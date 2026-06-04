CREATE TABLE IF NOT EXISTS post_translations (
  post_id TEXT NOT NULL,
  language TEXT NOT NULL,
  translated_text TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, language)
);
