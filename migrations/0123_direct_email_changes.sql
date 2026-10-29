-- This reserves application-profile email addresses without storing an Auth
-- grant, proof or password verifier in Flaxia's database.
CREATE TABLE flaxia_direct_email_changes (
  operation_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  target_email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied')),
  created_at TEXT NOT NULL
);
CREATE TRIGGER guard_reserved_email_insert BEFORE INSERT ON users
WHEN EXISTS (SELECT 1 FROM flaxia_direct_email_changes WHERE target_email = NEW.email COLLATE NOCASE AND user_id != NEW.id)
BEGIN SELECT RAISE(ABORT, 'email_reserved'); END;
CREATE TRIGGER guard_reserved_email_update BEFORE UPDATE OF email ON users
WHEN EXISTS (SELECT 1 FROM flaxia_direct_email_changes WHERE target_email = NEW.email COLLATE NOCASE AND user_id != NEW.id)
BEGIN SELECT RAISE(ABORT, 'email_reserved'); END;
CREATE TRIGGER guard_direct_email_deletion BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM flaxia_direct_email_changes WHERE user_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'email_change_pending'); END;
CREATE TRIGGER guard_pending_email_update BEFORE UPDATE OF email ON users
WHEN EXISTS (SELECT 1 FROM flaxia_direct_email_changes WHERE user_id = OLD.id)
 AND NOT EXISTS (SELECT 1 FROM flaxia_direct_email_changes WHERE user_id = OLD.id AND target_email = NEW.email COLLATE NOCASE AND state = 'applying')
BEGIN SELECT RAISE(ABORT, 'email_change_pending'); END;
CREATE TRIGGER guard_email_change_deletion BEFORE INSERT ON flaxia_direct_deletion_jobs
WHEN EXISTS (SELECT 1 FROM flaxia_direct_email_changes WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'email_change_pending'); END;
CREATE TRIGGER guard_deletion_email_change BEFORE INSERT ON flaxia_direct_email_changes
WHEN EXISTS (SELECT 1 FROM flaxia_direct_deletion_jobs WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'auth_deletion_guard'); END;
