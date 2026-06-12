-- Add performance indexes for common query patterns

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, post_id);

CREATE INDEX IF NOT EXISTS idx_post_embeddings_created ON post_embeddings(created_at);

CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);

