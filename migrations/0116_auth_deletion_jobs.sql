CREATE TABLE flaxia_auth_deletion_jobs (
  operation_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  grant_token TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved'))
);
CREATE TABLE flaxia_auth_deletion_receipts (
  operation_hash TEXT PRIMARY KEY NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE TRIGGER guard_deletion_pending_credentials BEFORE UPDATE OF password_hash, srp_salt, srp_verifier, srp_group, srp_kdf ON users
WHEN EXISTS (SELECT 1 FROM flaxia_auth_deletion_jobs WHERE user_id = OLD.id)
 AND (NEW.password_hash IS NOT OLD.password_hash OR NEW.srp_salt IS NOT OLD.srp_salt OR NEW.srp_verifier IS NOT OLD.srp_verifier OR NEW.srp_group IS NOT OLD.srp_group OR NEW.srp_kdf IS NOT OLD.srp_kdf)
BEGIN
  SELECT RAISE(ABORT, 'auth_deletion_guard');
END;
CREATE TRIGGER guard_deletion_pending_user BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM flaxia_auth_deletion_jobs WHERE user_id = OLD.id AND state != 'approved')
BEGIN
  SELECT RAISE(ABORT, 'auth_deletion_guard');
END;
