-- EXPLAIN QUERY PLAN (checked against the full migration set) showed five hot
-- paths still building a temp B-tree or a sort. Every index below is additive
-- and IF NOT EXISTS, so re-running this migration is a no-op. Partial-index
-- predicates intentionally match the routes' WHERE clauses exactly.

-- GET /api/posts?username= filters username, hidden and status then orders by
-- created_at DESC. Existing indexes stop before created_at, so SQLite builds a
-- temp B-tree for every user's timeline page. This leading equality columns +
-- descending tail lets the range scan come back already in order.
CREATE INDEX IF NOT EXISTS idx_posts_username_timeline
  ON posts(username, hidden, status, created_at DESC);

-- The archive/trending timeline uses a keyset cursor with a tie-breaker:
-- ORDER BY created_at DESC, id DESC with status/hidden/parent_id fixed. The
-- extra id DESC column removes the final sort even when several posts share a
-- timestamp, and the partial predicate restricts the index to that feed.
CREATE INDEX IF NOT EXISTS idx_posts_timeline_id
  ON posts(status, parent_id, created_at DESC, id DESC)
  WHERE parent_id IS NULL AND status='published' AND hidden=0;

-- EXACT_DUPLICATE_FILTER probes (user_id, text, hidden, parent_id) for the
-- original post before inserting a duplicate. Keeping those columns plus
-- created_at in one index makes that probe a covering seek instead of a table
-- row lookup on every candidate.
CREATE INDEX IF NOT EXISTS idx_posts_dup_cover
  ON posts(user_id, text, hidden, parent_id, created_at)
  WHERE status='published';

-- GET /api/games?trending=true orders the ZIP feed by
-- (fresh_count + impressions) DESC, created_at DESC. 0052's engagement index
-- uses engagement_hotness, a different expression, and cannot serve this ORDER
-- BY, so SQLite sorts all games. This expression index can — but the route must
-- force it with INDEXED BY, otherwise the planner still prefers 0052.
CREATE INDEX IF NOT EXISTS idx_posts_games_trending
  ON posts((fresh_count + impressions) DESC, created_at DESC)
  WHERE parent_id IS NULL AND status='published' AND hidden=0
    AND payload_key IS NOT NULL AND swf_key IS NULL;

-- Reaction summaries do `GROUP BY post_id, emoji` over the post's reaction
-- rows. Indexing (post_id, emoji) delivers the rows already grouped, removing
-- the temp B-tree used for the GROUP BY.
CREATE INDEX IF NOT EXISTS idx_reactions_post_emoji
  ON reactions(post_id, emoji);
