CREATE TABLE flaxia_auth_credential_jobs (
  operation_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  grant_token TEXT,
  proof_json TEXT,
  old_password_hash TEXT,
  old_salt TEXT,
  old_verifier TEXT,
  old_group TEXT,
  old_kdf TEXT,
  new_salt TEXT,
  new_verifier TEXT,
  new_group TEXT,
  new_kdf TEXT,
  target_stamp TEXT NOT NULL,
  vault_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'prepared', 'applying', 'local_committed', 'committed', 'cancelling', 'cancelled'))
);
CREATE UNIQUE INDEX idx_flaxia_one_active_credential_job ON flaxia_auth_credential_jobs(user_id)
  WHERE state NOT IN ('committed', 'cancelled');

DROP TRIGGER guard_provisioned_credentials;
DROP TRIGGER guard_linked_credentials;
CREATE TRIGGER guard_auth_credential_change BEFORE UPDATE OF password_hash, srp_salt, srp_verifier, srp_group, srp_kdf ON users
WHEN (EXISTS (SELECT 1 FROM flaxia_auth_provisioning WHERE user_id = OLD.id)
      OR EXISTS (SELECT 1 FROM flaxia_auth_links WHERE user_id = OLD.id)
      OR EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs WHERE user_id = OLD.id AND state NOT IN ('committed', 'cancelled')))
 AND (NEW.password_hash IS NOT OLD.password_hash OR NEW.srp_salt IS NOT OLD.srp_salt OR NEW.srp_verifier IS NOT OLD.srp_verifier OR NEW.srp_group IS NOT OLD.srp_group OR NEW.srp_kdf IS NOT OLD.srp_kdf)
 AND NOT EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs j
   WHERE j.user_id = OLD.id AND j.state = 'applying' AND OLD.password_hash IS j.old_password_hash
     AND OLD.srp_salt IS j.old_salt AND OLD.srp_verifier IS j.old_verifier AND OLD.srp_group IS j.old_group AND OLD.srp_kdf IS j.old_kdf
     AND NEW.password_hash = '' AND NEW.srp_salt IS j.new_salt AND NEW.srp_verifier IS j.new_verifier AND NEW.srp_group IS j.new_group AND NEW.srp_kdf IS j.new_kdf)
BEGIN
  SELECT RAISE(ABORT, 'auth_credential_guard');
END;
CREATE TRIGGER guard_credential_job_deletion BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs WHERE user_id = OLD.id AND state NOT IN ('committed', 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'auth_credential_guard');
END;
CREATE TRIGGER guard_credential_job_vault_insert BEFORE INSERT ON vault_keys
WHEN EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs WHERE user_id = NEW.user_id AND state NOT IN ('committed', 'cancelled', 'applying'))
BEGIN
  SELECT RAISE(ABORT, 'auth_credential_guard');
END;
CREATE TRIGGER guard_credential_job_vault_update BEFORE UPDATE ON vault_keys
WHEN EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs WHERE user_id = OLD.user_id AND state NOT IN ('committed', 'cancelled', 'applying'))
BEGIN
  SELECT RAISE(ABORT, 'auth_credential_guard');
END;
CREATE TRIGGER guard_credential_job_vault_delete BEFORE DELETE ON vault_keys
WHEN EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs WHERE user_id = OLD.user_id AND state NOT IN ('committed', 'cancelled', 'applying'))
BEGIN
  SELECT RAISE(ABORT, 'auth_credential_guard');
END;
-- Each D1 batch is serialized; inserting NULL deliberately aborts the entire
-- batch when an expected single-row update did not happen.
CREATE TABLE flaxia_auth_transition_assertions (valid INTEGER NOT NULL CHECK (valid = 1));
