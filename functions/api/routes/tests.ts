import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { hashPassword } from '../../lib/auth.ts';
import { badgeTypeForPlan } from '../../lib/billing';
import { ensureNsfwScansTable, ensurePendingEmbedsTable } from '../../lib/crowd.ts';
import type { Bindings, Variables } from '../types';

async function ensureReactionsTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS reactions (
           post_id    TEXT NOT NULL,
           user_id    TEXT NOT NULL,
           emoji      TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           PRIMARY KEY (post_id, user_id, emoji)
         )`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id)').run();
  } catch (e) {
    console.error('Failed to ensure reactions table:', e);
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Test helpers are only reachable from the test dev server. The decision is
 * based solely on unspoofable bindings — never on request-derived data such as
 * the URL or query string, which an attacker could control.
 */
function isTestEnvironment(c: Context<{ Bindings: Bindings; Variables: Variables }>): boolean {
  return c.env.ENVIRONMENT === 'test' || c.env.BASE_URL === 'http://localhost:8788';
}

// Attached to every /api/test/* route. The whole router is test-only, so a
// request that reaches these handlers must originate from the test server.
const requireTestEnvironment: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (c, next) => {
  if (!isTestEnvironment(c)) {
    return c.json({ error: 'Not found' }, 404);
  }
  await next();
};

// POST /api/test/reset - reset database for testing (only allowed in test environment)
app.post('/api/test/reset', requireTestEnvironment, async (c) => {
  const clears: D1Database[] = [];
  if (c.env.DB_TEST) clears.push(c.env.DB_TEST);
  if (c.env.DB) clears.push(c.env.DB);

  for (const db of clears) {
    await ensureNsfwScansTable(db);
    await ensurePendingEmbedsTable(db);
    await ensureReactionsTable(db);

    const resetOrder = [
      'poll_votes',
      'poll_options',
      'polls',
      'bookmarks',
      'likes',
      'shares',
      'reactions',
      'blocks',
      'ap_followers',
      'ap_following',
      'multiplayer_invites',
      'multiplayer_scores',
      'user_game_plays',
      'arcade_events',
      'counter_notifications',
      'notifications',
      'received_activities',
      'reports',
      'post_nsfw_scans',
      'pending_embeddings',
      'post_embeddings',
      'post_translations',
      'freshs',
      'custom_stamps',
      'transactions',
      'subscriptions',
      'stripe_events',
      'follows',
      'posts',
      'actor_keys',
      'vault_items',
      'device_keys',
      'vault_keys',
      'user_profiles',
      'push_subscriptions',
      'device_tokens',
      'sessions',
      'ad_interactions',
      'admin_alerts',
      'bandit_state',
      'ads',
      'users',
    ];
    const existing = new Set(
      (
        (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) as {
          results: { name: string }[];
        }
      ).results.map((r) => r.name),
    );
    const statements = resetOrder.filter((t) => existing.has(t)).map((t) => db.prepare(`DELETE FROM ${t}`));
    if (statements.length > 0) {
      await db.batch(statements);
    }
  }
  return c.json({ ok: true });
});

// GET /api/test/game-plays - inspect user_game_plays rows for integration tests.
// Gated like /api/test/reset: only reachable from the test dev server.
app.get('/api/test/game-plays', requireTestEnvironment, async (c) => {
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);

  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT post_id, dwell_ms, is_fullscreen, game_type, source
       FROM user_game_plays WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<{ post_id: string; dwell_ms: number; is_fullscreen: number; game_type: string; source: string }>();
  return c.json({ plays: rows.results || [] });
});

// GET /api/test/nsfw-scans - inspect post_nsfw_scans rows for integration tests.
// Gated like /api/test/reset: only reachable from the test dev server.
app.get('/api/test/nsfw-scans', requireTestEnvironment, async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(`SELECT post_id, task_id, status, created_at, scanned_at FROM post_nsfw_scans ORDER BY created_at DESC`)
    .all<{ post_id: string; task_id: string; status: string; created_at: string; scanned_at: string }>();
  return c.json({ scans: rows.results || [] });
});

// POST /api/test/subscription - seed a subscription row for billing tests.
// Gated like /api/test/reset: only reachable from the test dev server.
app.post('/api/test/subscription', requireTestEnvironment, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    username?: string;
    planId?: string;
    status?: string;
    currentPeriodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
    stripeCustomerId?: string | null;
  };
  if (!body.username) return c.json({ error: 'Missing username' }, 400);

  const db = c.env.DB;
  const user = await db.prepare('SELECT id FROM users WHERE username = ?').bind(body.username).first<{ id: string }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const id = crypto.randomUUID();
  const status = body.status ?? 'active';
  const planId = body.planId ?? 'flaxia_plus';
  await db
    .prepare(
      `INSERT INTO subscriptions (
         id, user_id, stripe_subscription_id, stripe_customer_id, plan_id, status,
         cancel_at_period_end, current_period_end
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      user.id,
      `sub_test_${id}`,
      body.stripeCustomerId ?? null,
      planId,
      status,
      body.cancelAtPeriodEnd ? 1 : 0,
      body.currentPeriodEnd ?? null,
    )
    .run();

  // Keep users.badge_type in sync the same way production webhooks do.
  await db
    .prepare('UPDATE users SET badge_type = ? WHERE id = ?')
    .bind(badgeTypeForPlan(planId, status), user.id)
    .run();

  if (body.stripeCustomerId) {
    await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind(body.stripeCustomerId, user.id).run();
  }

  return c.json({ id, userId: user.id });
});

// POST /api/test/seed-legacy-user - create an account that predates SRP.
//
// Registration is SRP-only, but the deprecated plaintext POST /api/auth/login
// must stay covered until it is deleted (see its cutoff note). This is the only
// way to produce an account that can still reach it.
app.post('/api/test/seed-legacy-user', requireTestEnvironment, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    username?: string;
    display_name?: string;
  };
  if (!body.email || !body.password || !body.username) {
    return c.json({ error: 'email, password and username are required' }, 400);
  }

  const db = c.env.DB;
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(body.email).first<{ id: string }>();
  if (existing) return c.json({ error: 'Email already registered' }, 409);

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(body.password);
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio)
       VALUES (?, ?, ?, ?, ?, '')`,
    )
    .bind(userId, body.email, passwordHash, body.username, body.display_name ?? body.username)
    .run();

  return c.json({ id: userId }, 201);
});

export default app;
