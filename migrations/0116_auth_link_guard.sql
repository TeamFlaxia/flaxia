-- Preserve a successful link after its individual sessions expire.
CREATE TABLE flaxia_auth_links (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO flaxia_auth_links (user_id)
  SELECT s.user_id FROM flaxia_auth_sessions a JOIN sessions s ON s.id = a.session_id;
CREATE TRIGGER guard_linked_credentials BEFORE UPDATE OF password_hash, srp_salt, srp_verifier, srp_group, srp_kdf ON users
WHEN EXISTS (SELECT 1 FROM flaxia_auth_links WHERE user_id = OLD.id)
 AND (NEW.password_hash IS NOT OLD.password_hash OR NEW.srp_salt IS NOT OLD.srp_salt OR NEW.srp_verifier IS NOT OLD.srp_verifier OR NEW.srp_group IS NOT OLD.srp_group OR NEW.srp_kdf IS NOT OLD.srp_kdf)
BEGIN
  SELECT RAISE(ABORT, 'auth_link_guard');
END;
CREATE TRIGGER guard_linked_deletion BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM flaxia_auth_links WHERE user_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'auth_link_guard');
END;
