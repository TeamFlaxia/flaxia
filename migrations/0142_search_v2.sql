CREATE TABLE IF NOT EXISTS search_documents (
  rowid         INTEGER PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('post', 'user')),
  ref_id        TEXT NOT NULL,
  author_id     TEXT,
  author        TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '',
  is_game       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (document_type, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_search_documents_type_created
  ON search_documents (document_type, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title,
  body,
  tags,
  author,
  content = 'search_documents',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS search_documents_ai
AFTER INSERT ON search_documents
BEGIN
  INSERT INTO search_fts (rowid, title, body, tags, author)
  VALUES (new.rowid, new.title, new.body, new.tags, new.author);
END;

CREATE TRIGGER IF NOT EXISTS search_documents_ad
AFTER DELETE ON search_documents
BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body, tags, author)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags, old.author);
END;

CREATE TRIGGER IF NOT EXISTS search_documents_au
AFTER UPDATE ON search_documents
BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body, tags, author)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags, old.author);
  INSERT INTO search_fts (rowid, title, body, tags, author)
  VALUES (new.rowid, new.title, new.body, new.tags, new.author);
END;

INSERT INTO search_documents (
  document_type, ref_id, author_id, author, title, body, tags, is_game, created_at
)
SELECT
  'post',
  p.id,
  p.user_id,
  p.username,
  '',
  trim(COALESCE(p.text, '') || ' ' || COALESCE(p.game_description, '')),
  COALESCE(p.hashtags, '[]'),
  CASE
    WHEN COALESCE(p.payload_key, '') != '' OR COALESCE(p.swf_key, '') != '' THEN 1
    ELSE 0
  END,
  p.created_at
FROM posts p
WHERE 1 = 1
ON CONFLICT (document_type, ref_id) DO UPDATE SET
  author_id = excluded.author_id,
  author = excluded.author,
  title = excluded.title,
  body = excluded.body,
  tags = excluded.tags,
  is_game = excluded.is_game,
  created_at = excluded.created_at,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

INSERT INTO search_documents (
  document_type, ref_id, author_id, author, title, body, tags, is_game, created_at
)
SELECT
  'user',
  u.id,
  u.id,
  u.username,
  COALESCE(u.display_name, ''),
  COALESCE(u.bio, ''),
  '',
  0,
  u.created_at
FROM users u
WHERE 1 = 1
ON CONFLICT (document_type, ref_id) DO UPDATE SET
  author_id = excluded.author_id,
  author = excluded.author,
  title = excluded.title,
  body = excluded.body,
  tags = excluded.tags,
  is_game = excluded.is_game,
  created_at = excluded.created_at,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

CREATE TRIGGER IF NOT EXISTS posts_search_ai
AFTER INSERT ON posts
BEGIN
  INSERT INTO search_documents (
    document_type, ref_id, author_id, author, title, body, tags, is_game, created_at
  )
  VALUES (
    'post',
    new.id,
    new.user_id,
    new.username,
    '',
    trim(COALESCE(new.text, '') || ' ' || COALESCE(new.game_description, '')),
    COALESCE(new.hashtags, '[]'),
    CASE
      WHEN COALESCE(new.payload_key, '') != '' OR COALESCE(new.swf_key, '') != '' THEN 1
      ELSE 0
    END,
    new.created_at
  )
  ON CONFLICT (document_type, ref_id) DO UPDATE SET
    author_id = excluded.author_id,
    author = excluded.author,
    title = excluded.title,
    body = excluded.body,
    tags = excluded.tags,
    is_game = excluded.is_game,
    created_at = excluded.created_at,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER IF NOT EXISTS posts_search_au
AFTER UPDATE ON posts
BEGIN
  INSERT INTO search_documents (
    document_type, ref_id, author_id, author, title, body, tags, is_game, created_at
  )
  VALUES (
    'post',
    new.id,
    new.user_id,
    new.username,
    '',
    trim(COALESCE(new.text, '') || ' ' || COALESCE(new.game_description, '')),
    COALESCE(new.hashtags, '[]'),
    CASE
      WHEN COALESCE(new.payload_key, '') != '' OR COALESCE(new.swf_key, '') != '' THEN 1
      ELSE 0
    END,
    new.created_at
  )
  ON CONFLICT (document_type, ref_id) DO UPDATE SET
    author_id = excluded.author_id,
    author = excluded.author,
    title = excluded.title,
    body = excluded.body,
    tags = excluded.tags,
    is_game = excluded.is_game,
    created_at = excluded.created_at,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER IF NOT EXISTS posts_search_ad
AFTER DELETE ON posts
BEGIN
  DELETE FROM search_documents WHERE document_type = 'post' AND ref_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS users_search_ai
AFTER INSERT ON users
BEGIN
  INSERT INTO search_documents (
    document_type, ref_id, author_id, author, title, body, tags, is_game, created_at
  )
  VALUES (
    'user',
    new.id,
    new.id,
    new.username,
    COALESCE(new.display_name, ''),
    COALESCE(new.bio, ''),
    '',
    0,
    new.created_at
  )
  ON CONFLICT (document_type, ref_id) DO UPDATE SET
    author_id = excluded.author_id,
    author = excluded.author,
    title = excluded.title,
    body = excluded.body,
    tags = excluded.tags,
    is_game = excluded.is_game,
    created_at = excluded.created_at,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER IF NOT EXISTS users_search_au
AFTER UPDATE ON users
BEGIN
  INSERT INTO search_documents (
    document_type, ref_id, author_id, author, title, body, tags, is_game, created_at
  )
  VALUES (
    'user',
    new.id,
    new.id,
    new.username,
    COALESCE(new.display_name, ''),
    COALESCE(new.bio, ''),
    '',
    0,
    new.created_at
  )
  ON CONFLICT (document_type, ref_id) DO UPDATE SET
    author_id = excluded.author_id,
    author = excluded.author,
    title = excluded.title,
    body = excluded.body,
    tags = excluded.tags,
    is_game = excluded.is_game,
    created_at = excluded.created_at,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER IF NOT EXISTS users_search_ad
AFTER DELETE ON users
BEGIN
  DELETE FROM search_documents WHERE document_type = 'user' AND ref_id = old.id;
END;
