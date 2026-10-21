-- Reviewer entitlement is a DB-controlled role, not an email string.
--
-- The old code granted Flaxia+ to any account whose email matched
-- `devtest@flaxia.app` case-insensitively. Since registration does not verify
-- email ownership, anyone could claim a case variant. 0103 makes the lookup
-- unique; this migration preserves the existing Play reviewer account while
-- new reviewer accounts must be promoted explicitly (never by registration):
--   UPDATE users SET role='reviewer', badge_type='flaxia_plus'
--   WHERE lower(email)='<reviewer-email>';
UPDATE users
SET role = 'reviewer', badge_type = 'flaxia_plus'
WHERE lower(email) = 'devtest@flaxia.app';
