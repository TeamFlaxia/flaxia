-- Add index on posts(user_id) for user-specific queries
-- User timeline: WHERE user_id = ? AND status = 'published' ORDER BY created_at DESC
-- Following timeline: JOIN on user_id

CREATE INDEX IF NOT EXISTS idx_posts_user_id_created ON posts(user_id, created_at DESC);

-- Add case-insensitive index on username for LOOKUP queries
-- Commonly used: WHERE username = ? COLLATE NOCASE

CREATE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
