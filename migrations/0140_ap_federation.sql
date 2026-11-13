-- ActivityPub federation: cache of remote actors, follower details, blocks,
-- delivery idempotency and the remote object id of a received post.
--
-- Before this migration the inbox only remembered the inbox URL of a
-- follower. Without the actor document the instance could not answer a
-- follower with a shared inbox, could not show who a remote post belongs to
-- and could not delete a remote post when the origin deleted it.

-- Remote actor documents, resolved once and reused for deliveries.
CREATE TABLE IF NOT EXISTS ap_actors (
  actor_url           TEXT PRIMARY KEY,
  inbox_url           TEXT NOT NULL,
  shared_inbox_url    TEXT,
  public_key_pem      TEXT,
  preferred_username  TEXT,
  display_name        TEXT,
  icon_url            TEXT,
  domain              TEXT,
  moved_to            TEXT,
  fetched_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ap_actors_domain ON ap_actors(domain);

-- A follower of a local account that lives on another instance.
ALTER TABLE ap_followers ADD COLUMN shared_inbox_url TEXT;
ALTER TABLE ap_followers ADD COLUMN username TEXT;
ALTER TABLE ap_followers ADD COLUMN domain TEXT;
ALTER TABLE ap_followers ADD COLUMN display_name TEXT;
ALTER TABLE ap_followers ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted';

CREATE INDEX IF NOT EXISTS idx_ap_followers_actor_url ON ap_followers(actor_url);

-- A remote account a local account follows.
ALTER TABLE ap_following ADD COLUMN shared_inbox_url TEXT;
ALTER TABLE ap_following ADD COLUMN display_name TEXT;

-- Remote actors a local account blocked.
CREATE TABLE IF NOT EXISTS ap_blocks (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  local_user_id TEXT NOT NULL,
  actor_url     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (local_user_id) REFERENCES users (id) ON DELETE CASCADE,
  UNIQUE (local_user_id, actor_url)
);

CREATE INDEX IF NOT EXISTS idx_ap_blocks_local_user_id ON ap_blocks(local_user_id);

-- Idempotency: an activity that was already processed is not processed again.
CREATE TABLE IF NOT EXISTS ap_activities (
  activity_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The ActivityPub object id of a post received from another instance. Needed
-- to answer a Delete of that post and to match a Like of a remote post.
ALTER TABLE posts ADD COLUMN ap_object_id TEXT;

CREATE INDEX IF NOT EXISTS idx_posts_ap_object_id ON posts(ap_object_id);
