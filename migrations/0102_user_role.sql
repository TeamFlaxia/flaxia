-- Role-based admin gate (#134).
--
-- Admin rights were bound to a username allowlist (ADMIN_USERNAMES): anyone
-- who (re-)registers a listed name inherits admin. Roles live on the user
-- row instead, so deleting or renaming an account cannot transfer privilege.
-- Existing rows default to 'user'; bootstrap the first admin with:
--   wrangler d1 execute DB --remote --command "UPDATE users SET role='admin' WHERE username='<name>'"
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
