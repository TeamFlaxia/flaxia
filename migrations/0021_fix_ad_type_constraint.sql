-- Create new ads table with corrected ad_type constraint
CREATE TABLE ads_new (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body_text    TEXT NOT NULL DEFAULT '' CHECK(length(body_text) <= 200),
  payload_key  TEXT,
  payload_type TEXT CHECK(payload_type IN ('zip', 'swf', 'gif', 'image')),
  preview_key  TEXT,
  click_url    TEXT CHECK(click_url NOT LIKE 'javascript:%'),
  active       INTEGER NOT NULL DEFAULT 0,
  impressions  INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  thumbnail_key TEXT,
  ad_type      TEXT DEFAULT 'self_hosted' CHECK(ad_type IN ('self_hosted', 'admax')),
  adsense_slot TEXT,
  adsense_client TEXT DEFAULT 'ca-pub-8703789531673358'
);

-- Copy data from old table with explicit column mapping
INSERT INTO ads_new (id, title, body_text, payload_key, payload_type, click_url, active, impressions, clicks, created_at, thumbnail_key, ad_type)
SELECT id, title, body_text, payload_key, payload_type, click_url, active, impressions, clicks, created_at, thumbnail_key, ad_type FROM ads;

-- Drop old table
DROP TABLE ads;

-- Rename new table
ALTER TABLE ads_new RENAME TO ads;

-- Update ads with no payload to be admax type
UPDATE ads SET ad_type = 'admax' WHERE payload_type IS NULL;
