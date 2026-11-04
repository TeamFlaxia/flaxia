import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { isTitleIconImage } from '../../../src/lib/title-icon.ts';
import { getMeWithSession, getSessionToken, hashPassword } from '../../lib/auth.ts';
import { badgeTypeForPlan } from '../../lib/billing.ts';
import { ensureNsfwScansTable, ensurePendingEmbedsTable } from '../../lib/crowd.ts';
import { ensureFileScansTable } from '../../lib/scan/db.ts';
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
    await ensureFileScansTable(db);

    const resetOrder = [
      // Remove transition guards first; otherwise their triggers correctly
      // prevent deleting Vault keys and users in the isolated test database.
      'flaxia_direct_deletion_jobs',
      'flaxia_direct_email_changes',
      'flaxia_direct_vault_changes',
      'flaxia_auth_deletion_jobs',
      'flaxia_auth_credential_jobs',
      'flaxia_auth_provisioning',
      'flaxia_auth_links',
      'flaxia_auth_purge_in_progress',
      'flaxia_auth_deletion_receipts',
      'flaxia_auth_transition_assertions',
      'profile_media_deletion_outbox',
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
      'file_scans',
      'file_blocklist',
      'pending_embeddings',
      'post_embeddings',
      'post_translations',
      'freshs',
      'embed_queue',
      'cc_queue',
      'cc_sources',
      'web_documents',
      'search_documents',
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
      'user_titles',
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
  // Drop the short-lived search caches as well: the KV entries survive database
  // resets otherwise and leak stale results into the next test.
  const cache = c.env.CACHE;
  if (cache) {
    try {
      for (const prefix of ['searchv2:', 'searchweb:']) {
        const keys = await cache.list({ prefix });
        for (const key of keys.keys) {
          await cache.delete(key.name);
        }
      }
    } catch (error) {
      console.error('Failed to purge search caches during test reset:', error);
    }
  }
  return c.json({ ok: true });
});

// POST /api/test/web-doc - seed a Common Crawl web-index document for search tests.
app.post('/api/test/web-doc', requireTestEnvironment, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return c.json({ error: 'Missing url' }, 400);
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
  } catch {
    return c.json({ error: 'Invalid url' }, 400);
  }
  const id = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID();
  const title = typeof body.title === 'string' ? body.title.slice(0, 300) : '';
  const excerpt = typeof body.excerpt === 'string' ? body.excerpt.slice(0, 400) : '';
  const lang = typeof body.lang === 'string' ? body.lang.slice(0, 16) : null;
  const publishedAt = typeof body.publishedAt === 'string' ? body.publishedAt.slice(0, 40) : null;
  await c.env.DB.prepare(
    `INSERT INTO web_documents
       (id, url, canonical_url, domain, lang, title, excerpt, published_at, crawl, status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CC-MAIN-TEST', 'active', ?)
     ON CONFLICT(id) DO UPDATE SET
       url = excluded.url,
       canonical_url = excluded.canonical_url,
       domain = excluded.domain,
       lang = excluded.lang,
       title = excluded.title,
       excerpt = excluded.excerpt,
       published_at = excluded.published_at,
       status = 'active',
       fetched_at = excluded.fetched_at`,
  )
    .bind(
      id,
      parsed.toString(),
      parsed.toString(),
      parsed.hostname.toLowerCase(),
      lang,
      title,
      excerpt,
      publishedAt,
      new Date().toISOString(),
    )
    .run();
  return c.json({ ok: true, id }, 201);
});

// POST /api/test/cc-queue - seed a Common Crawl queue row for webhook tests.
app.post('/api/test/cc-queue', requireTestEnvironment, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = typeof body.url === 'string' ? body.url : '';
  const warcFilename = typeof body.warcFilename === 'string' ? body.warcFilename : '';
  const offset = Number(body.offset);
  const length = Number(body.length);
  if (!url || !warcFilename || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
    return c.json({ error: 'Invalid queue row' }, 400);
  }
  const id = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID();
  const crawl = typeof body.crawl === 'string' ? body.crawl : 'CC-MAIN-TEST';
  const taskId = typeof body.taskId === 'string' ? body.taskId : null;
  const status = typeof body.status === 'string' ? body.status : 'submitted';
  await c.env.DB.prepare(
    `INSERT INTO cc_queue (id, crawl, url, warc_filename, offset, length, status, task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       crawl = excluded.crawl,
       url = excluded.url,
       warc_filename = excluded.warc_filename,
       offset = excluded.offset,
       length = excluded.length,
       status = excluded.status,
       task_id = excluded.task_id,
       error = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(id, crawl, url, warcFilename, offset, length, status, taskId)
    .run();
  return c.json({ ok: true, id }, 201);
});

// POST /api/test/vault-item - seed an encrypted vault item for rotation tests.
// The payload must come from the client test; the server only records ciphertext.
app.post('/api/test/vault-item', requireTestEnvironment, async (c) => {
  const token = getSessionToken(c.req.raw);
  const session = token ? await getMeWithSession(c.env, token) : null;
  const user = session?.user;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    item_id?: unknown;
    item_key_wrapped?: unknown;
    payload?: unknown;
  };
  if (
    typeof body.item_id !== 'string' ||
    typeof body.item_key_wrapped !== 'string' ||
    typeof body.payload !== 'string'
  ) {
    return c.json({ error: 'Invalid vault item' }, 400);
  }
  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO vault_items (id, user_id, item_key_wrapped, payload, kind, vk_version) VALUES (?, ?, ?, ?, ?, 1)',
  )
    .bind(body.item_id, user.id, body.item_key_wrapped, body.payload, 'text')
    .run();
  return c.json({ ok: true }, 201);
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
    .prepare(
      `SELECT post_id, media_key, task_id, content_sha, status, created_at, scanned_at FROM post_nsfw_scans ORDER BY created_at DESC`,
    )
    .all<{
      post_id: string;
      media_key: string;
      task_id: string;
      content_sha: string | null;
      status: string;
      created_at: string;
      scanned_at: string;
    }>();
  return c.json({ scans: rows.results || [] });
});

// GET /api/test/file-scans - inspect file_scans rows for integration tests.
// Gated like /api/test/reset: only reachable from the test dev server.
app.get('/api/test/file-scans', requireTestEnvironment, async (c) => {
  const db = c.env.DB;
  await ensureFileScansTable(db);
  const rows = await db
    .prepare(
      `SELECT r2_key, sha256, kind, structure_hash, text_hash, phash, status, detail, task_id, created_at, scanned_at
       FROM file_scans ORDER BY created_at DESC`,
    )
    .all<{
      r2_key: string;
      sha256: string;
      kind: string;
      structure_hash: string | null;
      text_hash: string | null;
      phash: string | null;
      status: string;
      detail: string | null;
      task_id: string | null;
      created_at: string;
      scanned_at: string | null;
    }>();
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

// POST /api/test/title - create a title definition for tests and local demos.
// Production titles are inserted by the systems that award them; the catalog
// starts empty. Gated like /api/test/reset: only reachable from the test server.
app.post('/api/test/title', requireTestEnvironment, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: unknown;
    icon?: unknown;
    name?: unknown;
    name_ja?: unknown;
    description?: unknown;
    description_ja?: unknown;
    sort_order?: unknown;
  };
  if (typeof body.icon !== 'string' || !isTitleIconImage(body.icon)) {
    return c.json({ error: 'icon must be an image URL' }, 400);
  }
  if (
    typeof body.id !== 'string' ||
    typeof body.name !== 'string' ||
    typeof body.name_ja !== 'string' ||
    typeof body.description !== 'string' ||
    typeof body.description_ja !== 'string'
  ) {
    return c.json({ error: 'id, icon, name, name_ja, description and description_ja are required' }, 400);
  }
  const sortOrder = typeof body.sort_order === 'number' ? body.sort_order : 0;

  await c.env.DB.prepare(
    `INSERT INTO titles (id, icon, name, name_ja, description, description_ja, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       icon = excluded.icon,
       name = excluded.name,
       name_ja = excluded.name_ja,
       description = excluded.description,
       description_ja = excluded.description_ja,
       sort_order = excluded.sort_order`,
  )
    .bind(body.id, body.icon, body.name, body.name_ja, body.description, body.description_ja, sortOrder)
    .run();
  return c.json({ ok: true }, 201);
});

// POST /api/test/grant-title - grant a title to a test account. Achievement
// systems are not implemented yet, so tests (and local demos) use this hook.
// Create the title first with POST /api/test/title. Gated like /api/test/reset:
// only reachable from the test dev server.
app.post('/api/test/grant-title', requireTestEnvironment, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: string; titleId?: string };
  if (!body.username || !body.titleId) {
    return c.json({ error: 'username and titleId are required' }, 400);
  }

  const db = c.env.DB;
  const user = await db.prepare('SELECT id FROM users WHERE username = ?').bind(body.username).first<{ id: string }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const title = await db.prepare('SELECT 1 FROM titles WHERE id = ?').bind(body.titleId).first();
  if (!title) return c.json({ error: 'Title not found' }, 404);

  await db
    .prepare('INSERT OR IGNORE INTO user_titles (user_id, title_id) VALUES (?, ?)')
    .bind(user.id, body.titleId)
    .run();
  return c.json({ ok: true }, 201);
});

// POST /api/test/seed-srp-v1-user - simulate an account created before KDF v2.
// Public registration rejects sha256-v1; this test-only helper seeds the legacy
// verifier format so the login-and-upgrade path remains covered.
app.post('/api/test/seed-srp-v1-user', requireTestEnvironment, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    username?: string;
    display_name?: string;
    srp_salt?: string;
    srp_verifier?: string;
  };
  if (!body.email || !body.username || !body.srp_salt || !body.srp_verifier) {
    return c.json({ error: 'email, username, srp_salt and srp_verifier are required' }, 400);
  }

  const id = crypto.randomUUID();
  const email = body.email.trim().toLowerCase();
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, username, display_name, bio, srp_salt, srp_verifier, srp_group, srp_kdf)
     VALUES (?, ?, '', ?, ?, '', ?, ?, '2048', 'sha256-v1')`,
  )
    .bind(id, email, body.username, body.display_name ?? body.username, body.srp_salt, body.srp_verifier)
    .run();
  return c.json({ id }, 201);
});

// POST /api/test/user-role - set a test account's role (reviewer semantics).
// Gated like /api/test/reset: only reachable from the test dev server. Roles
// are DB-controlled in production; registration must never grant one.
app.post('/api/test/user-role', requireTestEnvironment, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: string; role?: string };
  if (!body.username || (body.role !== 'reviewer' && body.role !== 'user')) {
    return c.json({ error: 'username and role (reviewer|user) are required' }, 400);
  }

  const db = c.env.DB;
  const user = await db.prepare('SELECT id FROM users WHERE username = ?').bind(body.username).first<{ id: string }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, user.id).run();
  return c.json({ ok: true });
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
  const email = body.email.trim().toLowerCase();
  const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = ?').bind(email).first<{ id: string }>();
  if (existing) return c.json({ error: 'Email already registered' }, 409);

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(body.password);
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio)
       VALUES (?, ?, ?, ?, ?, '')`,
    )
    .bind(userId, email, passwordHash, body.username, body.display_name ?? body.username)
    .run();

  return c.json({ id: userId }, 201);
});

export default app;
