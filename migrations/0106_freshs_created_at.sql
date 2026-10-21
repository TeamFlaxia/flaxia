ALTER TABLE freshs ADD COLUMN created_at TEXT;

UPDATE freshs
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE created_at IS NULL;
