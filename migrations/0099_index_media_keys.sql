-- Index the legacy media-key columns so hiding a post can cheaply resolve
-- key -> post on the media hot path (postKeyMediaAllowed in
-- functions/api/routes/media.ts). Partial indexes keep them small: rows
-- without a key are not indexed.
CREATE INDEX IF NOT EXISTS idx_posts_gif_key ON posts(gif_key) WHERE gif_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_payload_key ON posts(payload_key) WHERE payload_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_swf_key ON posts(swf_key) WHERE swf_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_thumbnail_key ON posts(thumbnail_key) WHERE thumbnail_key IS NOT NULL;
