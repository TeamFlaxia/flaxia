-- Game series / rolling updates: each upload of a new ZIP for an existing
-- game post is recorded as a version so players can keep playing older
-- releases. The current post.payload_key always points at the latest version;
-- archived versions live here and are referenced by id (?v=<id> in the sandbox).

CREATE TABLE IF NOT EXISTS game_versions (
  id            TEXT PRIMARY KEY,
  post_id       TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  payload_key   TEXT NOT NULL,
  thumbnail_key TEXT,
  changelog     TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (post_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_game_versions_post
  ON game_versions (post_id, version_number DESC);
