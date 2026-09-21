import Stripe from 'stripe';
import { getSession, getSessionToken } from './auth';

/**
 * Environment bindings required by the billing code. Stripe secrets are only
 * available to the billing/market Pages Functions, so this is kept separate
 * from the shared `Bindings` type.
 */
export type BillingEnv = {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** Stripe Price ID for Flaxia+ (e.g. price_xxx). Optional for local dev. */
  STRIPE_PRICE_FLXIA_PLUS?: string;
  BASE_URL: string;
  ENVIRONMENT?: string;
};

export const STRIPE_API_VERSION = '2026-08-26.dahlia';

export function getStripe(env: BillingEnv): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/**
 * Plans that can actually be purchased. Flaxia++ / Flaxia# are intentionally
 * hidden but remain valid plan ids in the database for future use.
 */
export const CHECKOUT_PLANS: Record<string, { name: string; priceMonthly: number; priceEnv?: string }> = {
  flaxia_plus: { name: 'Flaxia+', priceMonthly: 300 },
};

export const PLAN_NAMES: Record<string, string> = {
  flaxia_plus: 'Flaxia+',
  flaxia_plus_plus: 'Flaxia++',
  flaxia_sharp: 'Flaxia#',
};

/** Statuses that grant premium entitlements. */
export const ACTIVE_STATUSES = ['active', 'trialing'] as const;

/** Minimal env for helpers that only need the database (usable from Hono routes). */
export type BillingDbEnv = { DB: D1Database };

/** Statuses the UI should treat as "has a subscription". */
export const VISIBLE_STATUSES = ['active', 'trialing', 'past_due'] as const;

export type UserPlan = {
  planId: string | null;
  planName: string | null;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  isActive: boolean;
  stripeCustomerId: string | null;
};

const EMPTY_PLAN: UserPlan = {
  planId: null,
  planName: null,
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  isActive: false,
  stripeCustomerId: null,
};

/** Resolve the authenticated user id from the session cookie. */
export async function getRequestUserId(env: BillingEnv, request: Request): Promise<string | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  const session = await getSession(env as unknown as Env, token);
  return session?.user.id ?? null;
}

/** Read the user's current subscription, if any. */
export async function getUserPlan(env: BillingDbEnv, userId: string): Promise<UserPlan> {
  const row = await env.DB.prepare(
    `SELECT plan_id, status, current_period_end, cancel_at_period_end, stripe_customer_id
     FROM subscriptions
     WHERE user_id = ? AND status IN (${VISIBLE_STATUSES.map(() => '?').join(', ')})
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId, ...VISIBLE_STATUSES)
    .first<{
      plan_id: string;
      status: string;
      current_period_end: string | null;
      cancel_at_period_end: number | null;
      stripe_customer_id: string | null;
    }>();

  if (!row) {
    const user = await env.DB.prepare('SELECT stripe_customer_id FROM users WHERE id = ?')
      .bind(userId)
      .first<{ stripe_customer_id: string | null }>();
    return { ...EMPTY_PLAN, stripeCustomerId: user?.stripe_customer_id ?? null };
  }

  return {
    planId: row.plan_id,
    planName: PLAN_NAMES[row.plan_id] ?? row.plan_id,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
    isActive: (ACTIVE_STATUSES as readonly string[]).includes(row.status),
    stripeCustomerId: row.stripe_customer_id,
  };
}

/**
 * Return the user's Stripe Customer, creating one on first use and persisting
 * it on `users.stripe_customer_id` so subsequent checkouts reuse it.
 */
export async function getOrCreateStripeCustomer(env: BillingEnv, userId: string): Promise<string> {
  const user = await env.DB.prepare('SELECT email, username, stripe_customer_id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string | null; username: string | null; stripe_customer_id: string | null }>();

  if (user?.stripe_customer_id) return user.stripe_customer_id;

  // Fall back to a customer id learned through an existing subscription row.
  const legacy = await env.DB.prepare(
    'SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1',
  )
    .bind(userId)
    .first<{ stripe_customer_id: string }>();

  if (legacy?.stripe_customer_id) {
    await env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
      .bind(legacy.stripe_customer_id, userId)
      .run();
    return legacy.stripe_customer_id;
  }

  const stripe = getStripe(env);
  const customer = await stripe.customers.create({
    email: user?.email ?? undefined,
    metadata: { flaxia_user_id: userId, username: user?.username ?? '' },
  });

  await env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind(customer.id, userId).run();

  return customer.id;
}

/** Map a Stripe Price ID back to a plan id, when possible. */
export function planIdFromPrice(env: BillingEnv, priceId: string | undefined | null): string | null {
  if (!priceId) return null;
  if (env.STRIPE_PRICE_FLXIA_PLUS && priceId === env.STRIPE_PRICE_FLXIA_PLUS) return 'flaxia_plus';
  return null;
}

function toIso(seconds: number | null | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

type SubscriptionUpsertInput = {
  userId: string;
  planId: string;
  subscription: Stripe.Subscription;
};

/**
 * Insert or update the local subscription row from a Stripe Subscription.
 * Used by webhook events (created/updated/invoice.payment_*).
 */
export async function upsertSubscription(
  env: BillingEnv,
  { userId, planId, subscription }: SubscriptionUpsertInput,
): Promise<void> {
  const item = subscription.items.data[0];
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

  await env.DB.prepare(
    `INSERT INTO subscriptions (
       id, user_id, stripe_subscription_id, stripe_customer_id, plan_id, status,
       cancel_at_period_end, current_period_start, current_period_end
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_subscription_id) DO UPDATE SET
       plan_id = excluded.plan_id,
       stripe_customer_id = excluded.stripe_customer_id,
       status = excluded.status,
       cancel_at_period_end = excluded.cancel_at_period_end,
       current_period_start = excluded.current_period_start,
       current_period_end = excluded.current_period_end,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      subscription.id,
      customerId ?? null,
      planId,
      subscription.status,
      subscription.cancel_at_period_end ? 1 : 0,
      toIso(item?.current_period_start),
      toIso(item?.current_period_end),
    )
    .run();

  // Keep the user's customer id in sync for checkouts and the portal.
  if (customerId) {
    await env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL')
      .bind(customerId, userId)
      .run();
  }
}

/** Resolve a user id from a Stripe subscription (metadata or local row). */
export async function resolveUserIdForSubscription(
  env: BillingEnv,
  subscription: Stripe.Subscription,
): Promise<string | null> {
  if (subscription.metadata?.user_id) return subscription.metadata.user_id;

  const row = await env.DB.prepare('SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?')
    .bind(subscription.id)
    .first<{ user_id: string }>();
  if (row?.user_id) return row.user_id;

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (customerId) {
    const user = await env.DB.prepare('SELECT id FROM users WHERE stripe_customer_id = ?')
      .bind(customerId)
      .first<{ id: string }>();
    if (user?.id) return user.id;
  }
  return null;
}

/** Resolve a plan id from a Stripe subscription (metadata, local row, price). */
export async function resolvePlanIdForSubscription(
  env: BillingEnv,
  subscription: Stripe.Subscription,
): Promise<string | null> {
  if (subscription.metadata?.plan_id) return subscription.metadata.plan_id;

  const row = await env.DB.prepare('SELECT plan_id FROM subscriptions WHERE stripe_subscription_id = ?')
    .bind(subscription.id)
    .first<{ plan_id: string }>();
  if (row?.plan_id) return row.plan_id;

  return planIdFromPrice(env, subscription.items.data[0]?.price?.id);
}

const ALLOWED_ORIGINS = new Set([
  'http://localhost:8787',
  'http://localhost:5173',
  'https://flaxia.app',
  'https://sandbox.flaxia.app',
]);

/**
 * Same-origin guard for state-changing billing requests. Webhooks are exempt
 * because Stripe does not send an Origin header (they are authenticated by
 * signature instead).
 */
export function isAllowedOrigin(env: BillingEnv, request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  let baseOrigin = 'https://flaxia.app';
  try {
    baseOrigin = new URL(env.BASE_URL || 'https://flaxia.app').origin;
  } catch {
    // keep default
  }
  return ALLOWED_ORIGINS.has(origin) || origin === baseOrigin;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
