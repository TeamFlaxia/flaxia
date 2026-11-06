-- Personal recommendation state moved into the E2EE Vault.
-- The server no longer derives or stores a per-user interest vector, and the
-- Arcade dwell-time bandit is retired in favour of client-side cosine ranking.
DROP TABLE IF EXISTS user_profiles;
DROP TABLE IF EXISTS bandit_state;
