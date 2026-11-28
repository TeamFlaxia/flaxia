-- Imported Fediverse posts keep their full text (up to the 10,000-character
-- ingest cap), while locally authored posts stay at 200 characters. SQLite
-- cannot ALTER a CHECK constraint, so `posts` is rebuilt with a conditional
-- bound and all rows, indexes and search triggers are restored.
--
-- D1 may run the whole file in a transaction, in which case PRAGMA
-- foreign_keys below is a no-op. Dropping and immediately renaming the table
-- keeps every child FK definition intact (they point at the name `posts`).
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS posts_new;

CREATE TABLE posts_new (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  username    TEXT NOT NULL,
  text        TEXT NOT NULL CHECK (
    CASE WHEN actor_id IS NOT NULL THEN length(text) <= 10000 ELSE length(text) <= 200 END
  ),
  hashtags    TEXT NOT NULL DEFAULT '[]',
  gif_key     TEXT,
  payload_key TEXT,
  fresh_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT DEFAULT 'published',
  parent_id TEXT REFERENCES posts(id),
  root_id TEXT REFERENCES posts(id),
  depth INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  swf_key TEXT,
  impressions INTEGER NOT NULL DEFAULT 0,
  mentions TEXT DEFAULT '[]',
  thumbnail_key TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  actor_id TEXT,
  bookmark_count INTEGER DEFAULT 0,
  sentiment_score REAL,
  sentiment_task_id TEXT,
  edited_at TEXT,
  engagement_hotness REAL NOT NULL DEFAULT 1.0,
  game_description TEXT DEFAULT '',
  quoted_post_id TEXT REFERENCES posts(id),
  reload_count INTEGER NOT NULL DEFAULT 0,
  ai_tags TEXT NOT NULL DEFAULT '[]',
  ap_object_id TEXT,
  game_title TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  visibility_root_author_id TEXT
);

INSERT INTO posts_new (
  id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, created_at,
  status, parent_id, root_id, depth, reply_count, swf_key, impressions, mentions,
  thumbnail_key, hidden, actor_id, bookmark_count, sentiment_score, sentiment_task_id,
  edited_at, engagement_hotness, game_description, quoted_post_id, reload_count, ai_tags,
  ap_object_id, game_title, visibility, visibility_root_author_id
)
SELECT
  id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, created_at,
  status, parent_id, root_id, depth, reply_count, swf_key, impressions, mentions,
  thumbnail_key, hidden, actor_id, bookmark_count, sentiment_score, sentiment_task_id,
  edited_at, engagement_hotness, game_description, quoted_post_id, reload_count, ai_tags,
  ap_object_id, game_title, visibility, visibility_root_author_id
FROM posts;

DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;

CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user_id_created ON posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user_text_created ON posts(user_id, text, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_posts_root ON posts(root_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_ap_object_id ON posts(ap_object_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_ap_object_id_unique
  ON posts(ap_object_id) WHERE ap_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_timeline
  ON posts(status, parent_id, created_at DESC) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_timeline_id
  ON posts(status, parent_id, created_at DESC, id DESC)
  WHERE parent_id IS NULL AND status='published' AND hidden=0;
CREATE INDEX IF NOT EXISTS idx_posts_recommended_engagement
  ON posts(status, hidden, parent_id, engagement_hotness DESC, created_at DESC)
  WHERE parent_id IS NULL AND status = 'published' AND hidden = 0;
CREATE INDEX IF NOT EXISTS idx_posts_games_trending
  ON posts((fresh_count + impressions) DESC, created_at DESC)
  WHERE parent_id IS NULL AND status='published' AND hidden=0
    AND payload_key IS NOT NULL AND swf_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_gif_key ON posts(gif_key) WHERE gif_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_payload_key ON posts(payload_key) WHERE payload_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_swf_key ON posts(swf_key) WHERE swf_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_thumbnail_key ON posts(thumbnail_key) WHERE thumbnail_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_ai_tags ON posts(ai_tags);
CREATE INDEX IF NOT EXISTS idx_posts_quoted_post_id ON posts(quoted_post_id);
CREATE INDEX IF NOT EXISTS idx_posts_username_timeline
  ON posts(username, hidden, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_dup_cover
  ON posts(user_id, text, hidden, parent_id, created_at) WHERE status='published';

DROP TRIGGER IF EXISTS posts_search_ad;
CREATE TRIGGER posts_search_ad
AFTER DELETE ON posts
BEGIN
  DELETE FROM search_documents WHERE document_type = 'post' AND ref_id = old.id;
END;

DROP TRIGGER IF EXISTS posts_search_ai;
CREATE TRIGGER posts_search_ai
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

DROP TRIGGER IF EXISTS posts_search_au;
CREATE TRIGGER posts_search_au
AFTER UPDATE OF text, game_description, hashtags, payload_key, swf_key, username, created_at ON posts
WHEN old.text IS NOT new.text
  OR old.game_description IS NOT new.game_description
  OR old.hashtags IS NOT new.hashtags
  OR old.payload_key IS NOT new.payload_key
  OR old.swf_key IS NOT new.swf_key
  OR old.username IS NOT new.username
  OR old.created_at IS NOT new.created_at
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

PRAGMA foreign_keys = ON;
