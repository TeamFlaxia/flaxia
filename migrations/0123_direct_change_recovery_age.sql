-- Existing pending rows are treated as stale; new requests set their own time.
ALTER TABLE flaxia_direct_vault_changes ADD COLUMN created_at TEXT NOT NULL DEFAULT '2000-01-01T00:00:00.000Z';
