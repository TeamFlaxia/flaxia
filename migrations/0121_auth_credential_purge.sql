-- A short-lived marker permits only the one-way removal of local credentials.
CREATE TABLE flaxia_auth_purge_in_progress (user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id));
DROP TRIGGER guard_auth_credential_change;
CREATE TRIGGER guard_auth_credential_change BEFORE UPDATE OF password_hash, srp_salt, srp_verifier, srp_group, srp_kdf ON users
WHEN (EXISTS (SELECT 1 FROM flaxia_auth_provisioning WHERE user_id = OLD.id)
      OR EXISTS (SELECT 1 FROM flaxia_auth_links WHERE user_id = OLD.id)
      OR EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs WHERE user_id = OLD.id AND state NOT IN ('committed', 'cancelled')))
 AND (NEW.password_hash IS NOT OLD.password_hash OR NEW.srp_salt IS NOT OLD.srp_salt OR NEW.srp_verifier IS NOT OLD.srp_verifier OR NEW.srp_group IS NOT OLD.srp_group OR NEW.srp_kdf IS NOT OLD.srp_kdf)
 AND NOT (NEW.password_hash = '' AND NEW.srp_salt IS NULL AND NEW.srp_verifier IS NULL AND NEW.srp_group IS NULL AND NEW.srp_kdf IS NULL
   AND EXISTS (SELECT 1 FROM flaxia_auth_purge_in_progress WHERE user_id = OLD.id))
 AND NOT EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs j
   WHERE j.user_id = OLD.id AND j.state = 'applying' AND OLD.password_hash IS j.old_password_hash
     AND OLD.srp_salt IS j.old_salt AND OLD.srp_verifier IS j.old_verifier AND OLD.srp_group IS j.old_group AND OLD.srp_kdf IS j.old_kdf
     AND NEW.password_hash = '' AND NEW.srp_salt IS j.new_salt AND NEW.srp_verifier IS j.new_verifier AND NEW.srp_group IS j.new_group AND NEW.srp_kdf IS j.new_kdf)
BEGIN SELECT RAISE(ABORT, 'auth_credential_guard'); END;
