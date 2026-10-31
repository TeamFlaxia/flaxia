-- Persist the exact request before contacting Auth so a timeout can be retried.
CREATE TABLE flaxia_auth_provisioning (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  srp_salt TEXT NOT NULL,
  srp_verifier TEXT NOT NULL,
  srp_group TEXT NOT NULL,
  srp_kdf TEXT NOT NULL
);

-- Until the cross-service credential-change and deletion protocols exist,
-- prevent local credentials from diverging after a provisioning attempt.
CREATE TRIGGER guard_provisioned_credentials BEFORE UPDATE OF password_hash, srp_salt, srp_verifier, srp_group, srp_kdf ON users
WHEN EXISTS (SELECT 1 FROM flaxia_auth_provisioning WHERE user_id = OLD.id)
 AND (NEW.password_hash IS NOT OLD.password_hash OR NEW.srp_salt IS NOT OLD.srp_salt OR NEW.srp_verifier IS NOT OLD.srp_verifier OR NEW.srp_group IS NOT OLD.srp_group OR NEW.srp_kdf IS NOT OLD.srp_kdf)
BEGIN
  SELECT RAISE(ABORT, 'auth_provisioning_guard');
END;
CREATE TRIGGER guard_provisioned_deletion BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM flaxia_auth_provisioning WHERE user_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'auth_provisioning_guard');
END;
