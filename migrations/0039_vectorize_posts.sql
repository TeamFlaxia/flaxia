CREATE TABLE IF NOT EXISTS post_embeddings (
  post_id TEXT PRIMARY KEY,
  embedding TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'Qwen/Qwen3-Embedding-0.6B',
  dimensions INTEGER NOT NULL DEFAULT 1024,
  created_at TEXT DEFAULT (datetime('now'))
);
