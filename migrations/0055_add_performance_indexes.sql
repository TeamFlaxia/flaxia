-- Add missing indexes for common query patterns
-- These address the most impactful missing indexes identified in performance analysis

-- Notifications: dedup queries filter by user_id + post_id + type
-- Existing idx_notifications_user_id only covers (user_id, created_at DESC)
-- Adding (user_id, post_id, type) makes these point lookups instead of scans
CREATE INDEX IF NOT EXISTS idx_notifications_user_post_type
  ON notifications(user_id, post_id, type);

-- Follows: follower count and follower list queries filter by followee_id
-- Existing PK is (follower_id, followee_id), so queries on followee_id alone
-- cannot use any index and perform a full table scan
CREATE INDEX IF NOT EXISTS idx_follows_followee_id
  ON follows(followee_id);
