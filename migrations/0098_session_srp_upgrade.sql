-- SRP migration sessions: a legacy plaintext login creates a session that is
-- allowed to call /api/auth/upgrade-srp once. A stolen ordinary session must
-- not be able to replace the verifier before the account has migrated.
ALTER TABLE sessions ADD COLUMN srp_upgrade_allowed INTEGER NOT NULL DEFAULT 0;
