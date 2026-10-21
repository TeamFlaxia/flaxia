-- Migrate custom_stamps.name from :name: to :userId:name: format
-- This ensures global uniqueness and ownership verification

-- 1. Update existing stamps: prepend user_id to name
--    :thumbsup: -> :<userId>:thumbsup:
UPDATE custom_stamps
SET name = ':' || user_id || SUBSTR(name, 2)
WHERE name LIKE ':%' AND name NOT LIKE ':%:%';

-- 2. Update existing reactions that reference old-format stamp names
--    Join with custom_stamps to find the owner, then update emoji
UPDATE reactions
SET emoji = ':' || cs.user_id || SUBSTR(reactions.emoji, 2)
FROM custom_stamps cs
WHERE reactions.emoji = cs.name
  AND reactions.emoji LIKE ':%'
  AND reactions.emoji NOT LIKE ':%:%';
