ALTER TABLE users ADD COLUMN frozen_at TEXT;
ALTER TABLE users ADD COLUMN frozen_reason TEXT;

CREATE TABLE account_freeze_posts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  hidden_before_freeze INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
