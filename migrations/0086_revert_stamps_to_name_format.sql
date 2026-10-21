-- Revert stamps from :userId:name: to :name: format
-- :userId:name: -> :name:

-- 1. Update stamps: strip userId prefix
UPDATE custom_stamps
SET name = ':' || SUBSTR(SUBSTR(name, 2), INSTR(SUBSTR(name, 2), ':') + 1)
WHERE name LIKE ':%:%:%';

-- 2. Update reactions to match reverted stamp names
UPDATE reactions
SET emoji = ':' || SUBSTR(SUBSTR(emoji, 2), INSTR(SUBSTR(emoji, 2), ':') + 1)
WHERE emoji LIKE ':%:%:%';
