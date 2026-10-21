-- Migration: Add reactions table for emoji reactions on posts
CREATE TABLE IF NOT EXISTS reactions (
  post_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (post_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);
