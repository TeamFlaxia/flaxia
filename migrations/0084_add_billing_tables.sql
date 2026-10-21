-- Subscriptions table for premium plans (Flaxia+, Flaxia++, Flaxia#)
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('flaxia_plus', 'flaxia_plus_plus', 'flaxia_sharp')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'canceled', 'past_due', 'incomplete', 'trialing')),
  current_period_start TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id);

-- Transactions table for Flax-market and payment history
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  post_id TEXT,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('subscription', 'marketplace')),
  plan_id TEXT CHECK(plan_id IN ('flaxia_plus', 'flaxia_plus_plus', 'flaxia_sharp')),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'jpy',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed', 'refunded')),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_session_id ON transactions(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_payment_intent_id ON transactions(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_post_id ON transactions(post_id);
