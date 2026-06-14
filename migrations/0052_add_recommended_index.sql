-- Pre-computed engagement hotness (numerator of the engagement score formula)
-- Score = (fresh_count * 2.0 + impressions * 0.1 + 1.0) / ((unixepoch('now') - unixepoch(created_at)) / 3600.0 + 2.0)
-- This column stores the time-independent numerator so the ORDER BY expression is simpler
ALTER TABLE posts ADD COLUMN engagement_hotness REAL NOT NULL DEFAULT 1.0;

-- Backfill initial values for existing posts
UPDATE posts SET engagement_hotness = fresh_count * 2.0 + impressions * 0.1 + 1.0
WHERE engagement_hotness = 1.0;

-- Partial index covering the WHERE + ORDER BY of the engagement fallback query
CREATE INDEX IF NOT EXISTS idx_posts_recommended_engagement
ON posts(status, hidden, parent_id, engagement_hotness DESC, created_at DESC)
WHERE parent_id IS NULL AND status = 'published' AND hidden = 0;
