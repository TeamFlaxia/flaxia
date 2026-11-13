-- AI auto-tagging (d1-omni-600M decision + embeddinggemma-2), feat #2.
--
-- 1) trend_tag_candidates: the taxonomy the decision model chooses from.
--    Seed-filled by refreshTrendTagCandidates (crowd.ts) from the frequency
--    of user-supplied hashtags, then refreshed periodically so emerging
--    topics enter and stale ones leave. The decision call presents at most
--    TREND_TAG_CANDIDATE_LIMIT tags + "none"; a post is tagged Top3 above
--    none (0..3 tags).
--
-- 2) posts.ai_tags: AI-chosen tags kept separate from user hashtags so
--    provenance is auditable, rollback is a single UPDATE, and the UI can
--    badge AI tags later. tags/trending UNIONs both columns.
--
-- 3) pending_embeddings.payload: multimodal embed input (text + media URLs)
--    so image/audio posts keep a unified 768-dim embedding after the
--    Qwen3-Embedding-0.6B (1024d) -> EmbeddingGemma-2 (768d) switch.
CREATE TABLE IF NOT EXISTS trend_tag_candidates (
  tag TEXT PRIMARY KEY,
  score REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_trend_tag_candidates_active
  ON trend_tag_candidates(is_active, score DESC);

ALTER TABLE posts ADD COLUMN ai_tags TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_posts_ai_tags ON posts(ai_tags);

ALTER TABLE pending_embeddings ADD COLUMN payload TEXT;
