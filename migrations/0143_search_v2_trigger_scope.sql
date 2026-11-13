-- Narrow the search-index triggers created by 0129. A blanket AFTER UPDATE
-- rewrites the FTS row (and inflates D1's meta.changes) on every impression,
-- fresh, reload, bookmark, avatar, trust-score, or badge update.
DROP TRIGGER IF EXISTS posts_search_au;
DROP TRIGGER IF EXISTS users_search_au;

CREATE TRIGGER IF NOT EXISTS posts_search_au
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

CREATE TRIGGER IF NOT EXISTS users_search_au
AFTER UPDATE OF username, display_name, bio, created_at ON users
WHEN old.username IS NOT new.username
  OR old.display_name IS NOT new.display_name
  OR old.bio IS NOT new.bio
  OR old.created_at IS NOT new.created_at
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
