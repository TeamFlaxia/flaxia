import Stripe from 'stripe';
import {
  type BillingEnv,
  CHECKOUT_PLANS,
  getOrCreateStripeCustomer,
  getRequestUserId,
  getStripe,
  getUserPlan,
  isAllowedOrigin,
  jsonResponse,
  PLAN_NAMES,
  resolvePlanIdForSubscription,
  resolveUserIdForSubscription,
  upsertSubscription,
} from '../../lib/billing';

export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(p: Promise<unknown>): void;
}) {
  const env = context.env as unknown as BillingEnv;
  const url = new URL(context.request.url);
  const method = context.request.method;
  const path = url.pathname.replace(/^\/api\/billing\//, '');

  try {
    if (method === 'POST' && path === 'checkout') {
      return await handleCheckout(context.request, env);
    }

    if (method === 'POST' && path === 'webhook') {
      return await handleWebhook(context.request, env, context.waitUntil);
    }

    if (method === 'POST' && path === 'portal') {
      return await handlePortal(context.request, env);
    }

    if (method === 'GET' && path === 'plan') {
      return await handleGetPlan(context.request, env);
    }

    if (method === 'GET' && path === 'transactions') {
      return await handleGetTransactions(context.request, env);
    }
  } catch (err) {
    console.error(`Billing ${method} ${path} failed:`, err);
    return jsonResponse({ error: 'Billing request failed' }, 500);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

async function handleCheckout(request: Request, env: BillingEnv): Promise<Response> {
  const userId = await getRequestUserId(env, request);
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (!isAllowedOrigin(env, request)) return jsonResponse({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as { planId?: string };
  const planId = body.planId;
  const plan = planId ? CHECKOUT_PLANS[planId] : undefined;

  if (!planId || !plan) {
    return jsonResponse({ error: 'Invalid plan' }, 400);
  }

  // Do not allow a second subscription while one is still active.
  const current = await getUserPlan(env, userId);
  if (current.isActive) {
    return jsonResponse({ error: 'Already subscribed' }, 409);
  }

  const stripe = getStripe(env);
  const baseUrl = env.BASE_URL || 'https://flaxia.app';
  const customerId = await getOrCreateStripeCustomer(env, userId);

  const priceId = env.STRIPE_PRICE_FLXIA_PLUS;
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = priceId
    ? { price: priceId, quantity: 1 }
    : {
        price_data: {
          currency: 'jpy',
          product_data: { name: `${plan.name} - Flaxia Monthly`, metadata: { plan_id: planId } },
          unit_amount: plan.priceMonthly,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      };

  const session = await stripe.checkout.sessions.create(
    {
      customer: customerId,
      mode: 'subscription',
      line_items: [lineItem],
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing/canceled`,
      metadata: { user_id: userId, plan_id: planId, type: 'subscription' },
      subscription_data: { metadata: { user_id: userId, plan_id: planId } },
    },
    { idempotencyKey: `checkout:${userId}:${planId}:${Math.floor(Date.now() / 60000)}` },
  );

  if (!session.url) {
    return jsonResponse({ error: 'Failed to create checkout session' }, 502);
  }

  await env.DB.prepare(
    `INSERT INTO transactions (id, user_id, stripe_session_id, type, plan_id, amount, currency, status)
     VALUES (?, ?, ?, 'subscription', ?, ?, 'jpy', 'pending')
     ON CONFLICT(stripe_session_id) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), userId, session.id, planId, plan.priceMonthly)
    .run();

  return jsonResponse({ sessionId: session.id, url: session.url });
}

// ---------------------------------------------------------------------------
// Customer Portal
// ---------------------------------------------------------------------------

async function handlePortal(request: Request, env: BillingEnv): Promise<Response> {
  const userId = await getRequestUserId(env, request);
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (!isAllowedOrigin(env, request)) return jsonResponse({ error: 'Forbidden' }, 403);

  const baseUrl = env.BASE_URL || 'https://flaxia.app';
  const stripe = getStripe(env);
  const customerId = await getOrCreateStripeCustomer(env, userId);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/settings`,
  });

  return jsonResponse({ url: session.url });
}

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

async function handleGetPlan(request: Request, env: BillingEnv): Promise<Response> {
  const userId = await getRequestUserId(env, request);
  if (!userId)
    return jsonResponse({ plan: null, planName: null, status: null, expiresAt: null, cancelAtPeriodEnd: false });

  const plan = await getUserPlan(env, userId);
  return jsonResponse({
    plan: plan.planId,
    planName: plan.planName,
    status: plan.status,
    expiresAt: plan.currentPeriodEnd,
    cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
  });
}

async function handleGetTransactions(request: Request, env: BillingEnv): Promise<Response> {
  const userId = await getRequestUserId(env, request);
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);

  const rows = await env.DB.prepare(
    `SELECT id, type, plan_id, amount, currency, status, post_id, stripe_invoice_id, created_at
     FROM transactions WHERE user_id = ?
     ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(userId)
    .all();

  const transactions = (rows.results ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id,
      type: r.type,
      planId: r.plan_id,
      planName: r.plan_id ? (PLAN_NAMES[r.plan_id as string] ?? r.plan_id) : null,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      postId: r.post_id,
      invoiceId: r.stripe_invoice_id,
      createdAt: r.created_at,
    };
  });

  return jsonResponse({ transactions });
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

async function handleWebhook(
  request: Request,
  env: BillingEnv,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return jsonResponse({ error: 'Missing signature' }, 400);

  let event: Stripe.Event;
  try {
    const rawBody = await request.text();
    const stripe = getStripe(env);
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: `Webhook signature verification failed: ${message}` }, 400);
  }

  // Idempotency: Stripe retries deliveries. If we have already seen the event
  // id, acknowledge it without processing again.
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)')
    .bind(event.id, event.type)
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    return jsonResponse({ received: true, duplicate: true });
  }

  waitUntil(
    processWebhookEvent(event, env).catch(async (err) => {
      console.error(`Webhook event ${event.id} (${event.type}) processing failed:`, err);
      // Allow Stripe to retry by removing the idempotency marker.
      await env.DB.prepare('DELETE FROM stripe_events WHERE id = ?').bind(event.id).run();
    }),
  );

  return jsonResponse({ received: true });
}

export async function processWebhookEvent(event: Stripe.Event, env: BillingEnv): Promise<void> {
  const stripe = getStripe(env);

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;

      // Flax-market (kept working; not the focus of the Flaxia+ rollout).
      if (session.metadata?.type === 'marketplace') {
        if (
          session.metadata?.user_id &&
          session.metadata?.post_id &&
          session.payment_intent &&
          typeof session.payment_intent === 'string'
        ) {
          await env.DB.prepare(
            `UPDATE transactions SET status = 'completed', stripe_payment_intent_id = ?
             WHERE stripe_session_id = ? AND status = 'pending'`,
          )
            .bind(session.payment_intent, session.id)
            .run();
        }
        break;
      }

      const userId = session.metadata?.user_id;
      const planId = session.metadata?.plan_id;
      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

      if (userId && planId && subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await upsertSubscription(env, { userId, planId, subscription });
      }

      if (session.payment_intent && typeof session.payment_intent === 'string') {
        await env.DB.prepare(
          `UPDATE transactions SET status = 'completed', stripe_payment_intent_id = ?
           WHERE stripe_session_id = ? AND status = 'pending'`,
        )
          .bind(session.payment_intent, session.id)
          .run();
      }
      break;
    }

    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      await env.DB.prepare(
        "UPDATE transactions SET status = 'failed' WHERE stripe_session_id = ? AND status = 'pending'",
      )
        .bind(session.id)
        .run();
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = await resolveUserIdForSubscription(env, subscription);
      const planId = await resolvePlanIdForSubscription(env, subscription);
      if (userId && planId) {
        await upsertSubscription(env, { userId, planId, subscription });
      } else {
        console.warn(`Subscription ${subscription.id}: could not resolve user/plan, skipping`);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      await env.DB.prepare(
        `UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE stripe_subscription_id = ?`,
      )
        .bind(subscription.id)
        .run();
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const subscription = await resolveInvoiceSubscription(stripe, invoice);
      if (subscription) {
        const userId = await resolveUserIdForSubscription(env, subscription);
        const planId = await resolvePlanIdForSubscription(env, subscription);
        if (userId && planId) {
          await upsertSubscription(env, { userId, planId, subscription });
          await recordInvoiceTransaction(env, { userId, planId, invoice });
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subscription = await resolveInvoiceSubscription(stripe, invoice);
      if (subscription) {
        await env.DB.prepare(
          `UPDATE subscriptions SET status = 'past_due', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE stripe_subscription_id = ?`,
        )
          .bind(subscription.id)
          .run();
      }
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntent =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (paymentIntent) {
        await env.DB.prepare("UPDATE transactions SET status = 'refunded' WHERE stripe_payment_intent_id = ?")
          .bind(paymentIntent)
          .run();
      }
      break;
    }
  }
}

async function resolveInvoiceSubscription(
  stripe: Stripe,
  invoice: Stripe.Invoice,
): Promise<Stripe.Subscription | null> {
  const ref = invoice.parent?.subscription_details?.subscription;
  if (!ref) return null;
  if (typeof ref === 'string') return stripe.subscriptions.retrieve(ref);
  return ref;
}

/**
 * Resolve the PaymentIntent for an invoice. In this API version the invoice no
 * longer exposes `payment_intent` directly; it lives on the includable
 * `payments` list, which may need an explicit retrieve + expand.
 */
async function getInvoicePaymentIntent(stripe: Stripe, invoice: Stripe.Invoice): Promise<string | null> {
  let payments = invoice.payments;
  if (!payments) {
    try {
      const full = await stripe.invoices.retrieve(invoice.id, { expand: ['payments'] });
      payments = full.payments;
    } catch {
      return null;
    }
  }
  const pi = payments?.data?.[0]?.payment?.payment_intent;
  if (!pi) return null;
  return typeof pi === 'string' ? pi : pi.id;
}

async function recordInvoiceTransaction(
  env: BillingEnv,
  { userId, planId, invoice }: { userId: string; planId: string; invoice: Stripe.Invoice },
): Promise<void> {
  const invoiceId = invoice.id;
  if (!invoiceId) return;

  const stripe = getStripe(env);
  const amount = invoice.amount_paid ?? 0;
  const currency = invoice.currency ?? 'jpy';
  const paymentIntent = await getInvoicePaymentIntent(stripe, invoice);

  // The initial invoice belongs to the checkout that already created a pending
  // transaction — attach the invoice to it instead of inserting a duplicate.
  const pending = await env.DB.prepare(
    `SELECT id FROM transactions
     WHERE user_id = ? AND type = 'subscription' AND stripe_invoice_id IS NULL
       AND status IN ('pending', 'completed')
       AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: string }>();

  if (pending?.id) {
    await env.DB.prepare(
      `UPDATE transactions
       SET stripe_invoice_id = ?, stripe_payment_intent_id = ?, amount = ?, currency = ?, status = 'completed'
       WHERE id = ?`,
    )
      .bind(invoiceId, paymentIntent, amount, currency, pending.id)
      .run();
    return;
  }

  await env.DB.prepare(
    `INSERT INTO transactions (id, user_id, stripe_invoice_id, stripe_payment_intent_id, type, plan_id, amount, currency, status)
     VALUES (?, ?, ?, ?, 'subscription', ?, ?, ?, 'completed')
     ON CONFLICT(stripe_invoice_id) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), userId, invoiceId, paymentIntent, planId, amount, currency)
    .run();
}
