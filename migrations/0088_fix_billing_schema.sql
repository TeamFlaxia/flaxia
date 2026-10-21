-- Billing schema fixes for the Flaxia+ subscription rollout.
--
-- 1. Stripe can report subscription statuses that the original CHECK constraint
--    (migration 0084) rejected: incomplete_expired, unpaid, paused. Those
--    webhook upserts would fail, so the table is recreated with a relaxed
--    constraint.
-- 2. `cancel_at_period_end` lets the UI show a pending cancellation.
-- 3. `users.stripe_customer_id` stores the Stripe Customer so checkout no
--    longer creates a duplicate customer on every request.
-- 4. `transactions.stripe_invoice_id` records recurring invoice payments for
--    the billing history.
-- 5. `stripe_events` makes webhook processing idempotent.

-- --- Stripe customer on the user row -----------------------------------------

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id);

-- Backfill from any customer id already learned through subscriptions.
UPDATE users
SET stripe_customer_id = (
  SELECT s.stripe_customer_id
  FROM subscriptions s
  WHERE s.user_id = users.id
    AND s.stripe_customer_id IS NOT NULL
  LIMIT 1
)
WHERE stripe_customer_id IS NULL;

-- --- Recreate subscriptions with a relaxed status constraint -----------------

CREATE TABLE subscriptions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('flaxia_plus', 'flaxia_plus_plus', 'flaxia_sharp')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'active', 'canceled', 'past_due', 'incomplete', 'incomplete_expired',
    'trialing', 'unpaid', 'paused'
  )),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  current_period_start TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO subscriptions_new (
  id, user_id, stripe_subscription_id, stripe_customer_id, plan_id, status,
  current_period_start, current_period_end, created_at, updated_at
)
SELECT
  id, user_id, stripe_subscription_id, stripe_customer_id, plan_id, status,
  current_period_start, current_period_end, created_at, updated_at
FROM subscriptions;

DROP TABLE subscriptions;

ALTER TABLE subscriptions_new RENAME TO subscriptions;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id);

-- --- Invoice history on transactions -----------------------------------------

ALTER TABLE transactions ADD COLUMN stripe_invoice_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_stripe_invoice_id ON transactions(stripe_invoice_id);

-- --- Webhook idempotency -----------------------------------------------------

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);