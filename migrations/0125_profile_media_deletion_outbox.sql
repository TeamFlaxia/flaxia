-- Profile images use content-addressed keys shared by users. While a key is
-- queued for deletion, block a new profile reference until R2 cleanup finishes.
CREATE TABLE profile_media_deletion_outbox (object_key TEXT PRIMARY KEY NOT NULL, claim_token TEXT, claimed_at TEXT, last_checked TEXT NOT NULL DEFAULT '');
CREATE TRIGGER guard_profile_media_gc_insert BEFORE INSERT ON users
WHEN EXISTS (SELECT 1 FROM profile_media_deletion_outbox WHERE object_key = NEW.avatar_key OR object_key = NEW.header_key)
BEGIN SELECT RAISE(ABORT, 'profile_media_deletion_pending'); END;
CREATE TRIGGER guard_profile_media_gc_update BEFORE UPDATE OF avatar_key, header_key ON users
WHEN EXISTS (SELECT 1 FROM profile_media_deletion_outbox WHERE object_key = NEW.avatar_key OR object_key = NEW.header_key)
BEGIN SELECT RAISE(ABORT, 'profile_media_deletion_pending'); END;
