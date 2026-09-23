-- Badge type on the user row for avatar checkmarks and future paid tiers.
-- NULL = no badge, 'flaxia_plus' = Flaxia+ checkmark (only sellable tier today).

ALTER TABLE users ADD COLUMN badge_type TEXT;

-- Backfill from active/trialing subscriptions.
UPDATE users
SET badge_type = 'flaxia_plus'
WHERE id IN (
  SELECT user_id FROM subscriptions
  WHERE status IN ('active', 'trialing')
);
