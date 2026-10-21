-- Precomputed LinUCB bandit projections for Arcade embeddings.
-- The random projection (seed/srcDim/dim) is deterministic, so the 64-dim
-- projected vector can be materialized at embed time and reused across
-- requests, avoiding a 64x1024 matmul per candidate on the read path.
-- bandit_cfg stores the projection config key the vector was computed with so
-- reads can detect staleness when the bandit config changes.
ALTER TABLE post_embeddings ADD COLUMN bandit_vec TEXT;
ALTER TABLE post_embeddings ADD COLUMN bandit_cfg TEXT;
