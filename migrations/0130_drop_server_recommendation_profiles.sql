-- Personal recommendation state moved into the E2EE Vault.
-- The server no longer derives or stores a per-user interest vector, and the
-- Arcade dwell-time bandit is retired in favour of client-side cosine ranking.
--
-- Deploy the application code that stops reading these tables BEFORE applying
-- this migration. The previous release still queries user_profiles /
-- bandit_state, so dropping them first breaks For You and Arcade until the
-- new build is live.
DROP TABLE IF EXISTS user_profiles;
DROP TABLE IF EXISTS bandit_state;
