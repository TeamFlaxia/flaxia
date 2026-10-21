CREATE INDEX IF NOT EXISTS idx_posts_user_text_created ON posts(user_id, text, created_at DESC);
