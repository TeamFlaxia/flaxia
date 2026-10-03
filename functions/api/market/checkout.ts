import Stripe from 'stripe';

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  BASE_URL: string;
};

function getStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-08-26.dahlia',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const sessionCookie = cookies.find((c) => c.startsWith('session='));
  return sessionCookie ? sessionCookie.substring('session='.length) : null;
}

async function getUserId(env: Env, request: Request): Promise<string | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  // Expiry is part of the session check: an expired or leaked token must not
  // keep creating checkout sessions forever.
  const session = await env.DB.prepare(
    "SELECT user_id FROM sessions WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  )
    .bind(token)
    .first<{ user_id: string }>();
  return session?.user_id ?? null;
}

// This endpoint lives outside the Hono router, so it enforces the same origin
// allowlist as the CSRF middleware itself.
const CHECKOUT_ALLOWED_ORIGINS = new Set(['http://localhost:8787', 'http://localhost:5173', 'https://flaxia.app']);

function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // server-side clients do not send Origin
  if (CHECKOUT_ALLOWED_ORIGINS.has(origin)) return true;
  return Boolean(env.BASE_URL) && origin === new URL(env.BASE_URL).origin;
}

export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(p: Promise<unknown>): void;
}) {
  const env = context.env as unknown as Env;
  const url = new URL(context.request.url);
  const method = context.request.method;
  const path = url.pathname.replace(/^\/api\/market\//, '');

  if (method === 'POST' && path === 'checkout') {
    return handleMarketCheckout(context.request, env);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleMarketCheckout(request: Request, env: Env): Promise<Response> {
  if (!isAllowedOrigin(request, env)) {
    return new Response(JSON.stringify({ error: 'CSRF validation failed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const userId = await getUserId(env, request);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = (await request.json()) as { postId?: string; amount?: number; title?: string };
  const { postId, amount, title } = body;

  if (!postId || !amount || amount < 100 || amount > 50000) {
    return new Response(JSON.stringify({ error: 'Invalid request: postId and amount (100-50000) required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify the post exists
  const post = await env.DB.prepare('SELECT id, user_id, text FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ id: string; user_id: string; text: string }>();

  if (!post) {
    return new Response(JSON.stringify({ error: 'Post not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Cannot buy your own content
  if (post.user_id === userId) {
    return new Response(JSON.stringify({ error: 'Cannot purchase your own content' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check if user already purchased this content
  const existing = await env.DB.prepare(
    "SELECT id FROM transactions WHERE user_id = ? AND post_id = ? AND status = 'completed' LIMIT 1",
  )
    .bind(userId, postId)
    .first();

  if (existing) {
    return new Response(JSON.stringify({ error: 'Already purchased' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check if buyer has Flaxia++ (they get free access to marketplace content)
  const sub = await env.DB.prepare(
    "SELECT plan_id FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') AND plan_id IN ('flaxia_plus_plus', 'flaxia_sharp') LIMIT 1",
  )
    .bind(userId)
    .first<{ plan_id: string }>();

  if (sub) {
    return new Response(JSON.stringify({ error: 'Flaxia++ subscribers have free access to marketplace content' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get or create Stripe customer
  const existingSub = await env.DB.prepare(
    'SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1',
  )
    .bind(userId)
    .first<{ stripe_customer_id: string }>();

  let customerId = existingSub?.stripe_customer_id;

  if (!customerId) {
    const user = await env.DB.prepare('SELECT email, username FROM users WHERE id = ?')
      .bind(userId)
      .first<{ email: string; username: string }>();

    const stripe = getStripe(env);
    const customer = await stripe.customers.create({
      email: user?.email,
      metadata: { flaxia_user_id: userId, username: user?.username || '' },
    });
    customerId = customer.id;
  }

  const stripe = getStripe(env);
  const baseUrl = env.BASE_URL || 'https://flaxia.app';
  const contentTitle = title || post.text.slice(0, 50) || 'Flaxia Content';

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'jpy',
          product_data: {
            name: contentTitle,
            metadata: { post_id: postId, seller_id: post.user_id },
          },
          unit_amount: amount,
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}&type=marketplace`,
    cancel_url: `${baseUrl}/billing/canceled`,
    metadata: { user_id: userId, post_id: postId, type: 'marketplace' },
  });

  // Record pending transaction
  await env.DB.prepare(
    `INSERT INTO transactions (id, user_id, post_id, stripe_session_id, type, amount, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_session_id) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), userId, postId, session.id, 'marketplace', amount, 'jpy', 'pending')
    .run();

  return new Response(JSON.stringify({ sessionId: session.id, url: session.url }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
