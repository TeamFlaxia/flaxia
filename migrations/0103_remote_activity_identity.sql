-- Remote Like/Announce actors are not local users. A local user_id must not
-- be filled with the literal 'unknown' (which violates the FK).
-- Keep actor_id as the remote identity, while retaining local-user shares.
CREATE TABLE likes_new (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(post_id, actor_id)
);
INSERT INTO likes_new (id, post_id, user_id, actor_id, created_at)
 SELECT id, post_id, CASE WHEN user_id = 'unknown' THEN NULL ELSE user_id END, actor_id, created_at FROM likes;
DROP TABLE likes;
ALTER TABLE likes_new RENAME TO likes;
CREATE INDEX idx_likes_post_id ON likes(post_id);
CREATE INDEX idx_likes_user_id ON likes(user_id);
CREATE INDEX idx_likes_actor_id ON likes(actor_id);

CREATE TABLE shares_new (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(post_id, actor_id)
);
INSERT INTO shares_new (id, post_id, user_id, actor_id, created_at)
 SELECT id, post_id, CASE WHEN user_id = 'unknown' THEN NULL ELSE user_id END, actor_id, created_at FROM shares;
DROP TABLE shares;
ALTER TABLE shares_new RENAME TO shares;
CREATE INDEX idx_shares_post_id ON shares(post_id);
CREATE INDEX idx_shares_user_id ON shares(user_id);
CREATE INDEX idx_shares_actor_id ON shares(actor_id);
