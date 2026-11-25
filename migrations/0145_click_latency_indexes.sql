-- Click latency: the fresh / bookmark / share toggles re-read "my" list with
-- `WHERE user_id = ? ORDER BY created_at DESC`. Existing indexes either omit
-- created_at (0050, 0015, 0109) or lead with post_id (0048), so SQLite sorts
-- every row for that user on every click. These composite indexes cover both
-- the equality and the descending ORDER BY. Additive and IF NOT EXISTS, so
-- re-running this migration is a no-op.

CREATE INDEX IF NOT EXISTS idx_freshs_user_created
  ON freshs (user_id, created_at DESC);

-- bookmarks PK is (post_id, user_id) and 0048 covers (user_id, post_id);
-- neither can serve ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_created
  ON bookmarks (user_id, created_at DESC);

-- shares has per-column indexes (0015) and (post_id, user_id) (0109), but
-- none include created_at.
CREATE INDEX IF NOT EXISTS idx_shares_user_created
  ON shares (user_id, created_at DESC);

-- Not indexed here: the For You trending feed (GET /api/posts/recommended)
-- orders by a computed expression (EXP/LN/MAX based score), so the plain
-- index from 0052 cannot be used. A B-tree index cannot accelerate a computed
-- ORDER BY; it would need an expression index or a precomputed score column.
-- Left as-is intentionally — do not add a misleading index for that query.

-- Also not created here: 0101 tried to add a UNIQUE constraint via
-- idx_users_username_nocase on lower(username), but 0049 already created a
-- non-unique index with that exact name, so SQLite skipped the UNIQUE
-- constraint. A differently-named unique index (e.g.
-- idx_users_username_nocase_unique_v2) would fix the name collision, but it
-- would fail outright on existing data if any case-insensitive usernames are
-- duplicates. Safety first: skip it here; add it only after a dedupe/audit
-- confirms there are no duplicates.
