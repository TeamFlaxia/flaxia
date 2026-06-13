-- Add index for freshs queries by user_id
-- The PK is (post_id, user_id), so queries filtering by user_id are full scans
CREATE INDEX IF NOT EXISTS idx_freshs_user ON freshs(user_id, post_id);
