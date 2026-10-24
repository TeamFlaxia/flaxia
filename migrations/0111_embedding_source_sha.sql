-- Bind the indexing indicator to the exact post text that was embedded.
-- Historical embeddings remain unknown until re-indexed.
ALTER TABLE post_embeddings ADD COLUMN source_sha TEXT;
