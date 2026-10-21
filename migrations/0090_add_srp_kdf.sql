-- SRP KDF versioning for the private value x.
--
-- x = KDF(password, salt) is what g^x (the stored verifier) commits to, so
-- whoever holds a D1 dump dictionary-attacks x offline. Until now x was a
-- single SHA-256: one hash per guess. The derivation is computed exclusively by
-- the client (the server only ever compares v), so raising its cost is free on
-- the server side.
--
--   sha256-v1        x = SHA-256(salt | password)         <- every row today
--   pbkdf2-600k-v2   x = PBKDF2-SHA256(password, salt, 600_000)
--
-- NULL is not used as "v1": an explicit value keeps the metric
-- (`srp_kdf IS NULL` = never migrated / legacy plaintext account) meaningful.
ALTER TABLE users ADD COLUMN srp_kdf TEXT;

-- Existing SRP accounts were all registered with v1, so label them as such.
-- They migrate to v2 at the next event where the browser holds the plaintext
-- password: legacy login upgrade, password change, or vault enable.
UPDATE users SET srp_kdf = 'sha256-v1' WHERE srp_salt IS NOT NULL;
