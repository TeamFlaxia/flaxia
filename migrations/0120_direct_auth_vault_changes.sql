-- Coordination for a Vault rewrap. Password verifiers, proofs and grants live
-- only at Auth or in the initiating request; no credential is copied here.
CREATE TABLE flaxia_direct_vault_changes (
  operation_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_stamp TEXT NOT NULL,
  vault_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'prepared', 'applying', 'local_committed', 'committed', 'cancelling', 'cancelled'))
);
CREATE UNIQUE INDEX flaxia_direct_vault_one_active ON flaxia_direct_vault_changes(user_id)
  WHERE state NOT IN ('committed', 'cancelled');
CREATE TRIGGER guard_direct_change_vault_insert BEFORE INSERT ON vault_keys
WHEN EXISTS (SELECT 1 FROM flaxia_direct_vault_changes WHERE user_id = NEW.user_id AND state NOT IN ('committed', 'cancelled', 'applying'))
BEGIN SELECT RAISE(ABORT, 'auth_credential_guard'); END;
CREATE TRIGGER guard_direct_change_vault_update BEFORE UPDATE ON vault_keys
WHEN EXISTS (SELECT 1 FROM flaxia_direct_vault_changes WHERE user_id = OLD.user_id AND state NOT IN ('committed', 'cancelled', 'applying'))
BEGIN SELECT RAISE(ABORT, 'auth_credential_guard'); END;
CREATE TRIGGER guard_direct_change_vault_delete BEFORE DELETE ON vault_keys
WHEN EXISTS (SELECT 1 FROM flaxia_direct_vault_changes WHERE user_id = OLD.user_id AND state NOT IN ('committed', 'cancelled', 'applying'))
BEGIN SELECT RAISE(ABORT, 'auth_credential_guard'); END;
CREATE TRIGGER guard_direct_change_user_delete BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM flaxia_direct_vault_changes WHERE user_id = OLD.id AND state NOT IN ('committed', 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'auth_credential_guard'); END;
