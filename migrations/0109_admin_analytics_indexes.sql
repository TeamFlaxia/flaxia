-- Global time-range scans for the bounded admin analytics dashboard.
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_freshs_created_at ON freshs(created_at);
CREATE INDEX IF NOT EXISTS idx_ugp_created_at ON user_game_plays(created_at);
