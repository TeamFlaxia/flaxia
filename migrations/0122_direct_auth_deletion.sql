CREATE TABLE flaxia_direct_deletion_jobs (
  operation_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved')),
  last_checked TEXT NOT NULL DEFAULT ''
);
CREATE TRIGGER guard_direct_deletion_user BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM flaxia_direct_deletion_jobs WHERE user_id = OLD.id AND state != 'approved')
BEGIN SELECT RAISE(ABORT, 'auth_deletion_guard'); END;
CREATE TRIGGER guard_direct_deletion_vault_change BEFORE INSERT ON flaxia_direct_vault_changes
WHEN EXISTS (SELECT 1 FROM flaxia_direct_deletion_jobs WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'auth_deletion_guard'); END;
CREATE TRIGGER guard_direct_change_deletion BEFORE INSERT ON flaxia_direct_deletion_jobs
WHEN EXISTS (SELECT 1 FROM flaxia_direct_vault_changes WHERE user_id = NEW.user_id AND state NOT IN ('committed', 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'auth_credential_guard'); END;
