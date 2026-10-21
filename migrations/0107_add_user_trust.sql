ALTER TABLE users ADD COLUMN trust_score REAL NOT NULL DEFAULT 1.0;
ALTER TABLE users ADD COLUMN repetition_score REAL NOT NULL DEFAULT 0.0;
ALTER TABLE users ADD COLUMN trust_updated_at TEXT;

WITH recent_posts AS (
  SELECT user_id, lower(trim(text)) AS normalized
  FROM posts
  WHERE actor_id IS NULL
    AND status = 'published'
    AND hidden = 0
    AND parent_id IS NULL
    AND length(trim(text)) > 0
    AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
),
duplicate_groups AS (
  SELECT user_id, normalized, COUNT(*) AS copies
  FROM recent_posts
  GROUP BY user_id, normalized
  HAVING COUNT(*) >= 3
),
scored AS (
  SELECT recent_posts.user_id,
         COUNT(*) AS total,
         SUM(CASE WHEN duplicate_groups.normalized IS NOT NULL THEN 1 ELSE 0 END) AS repeated
  FROM recent_posts
  LEFT JOIN duplicate_groups
    ON duplicate_groups.user_id = recent_posts.user_id
   AND duplicate_groups.normalized = recent_posts.normalized
  GROUP BY recent_posts.user_id
)
UPDATE users
SET repetition_score = CASE
      WHEN scored.total > 0 THEN (1.0 * scored.repeated) / scored.total
      ELSE 0.0
    END,
    trust_score = MAX(0.1, 1.0 - (1.0 * scored.repeated) / scored.total)
FROM scored
WHERE users.id = scored.user_id;
