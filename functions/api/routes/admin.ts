import { FlaxiaClient } from '@flaxia/sdk';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { isAdmin } from '../../../src/lib/admin';
import { extractFileFromZip } from '../../../src/lib/wvfs-zip-server';
import { deleteAccount } from '../../lib/account-deletion';
import { validateImageDimensions } from '../../lib/image-dimensions';
import { requireAdmin, requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Embedding constants & helpers ────────────────────────────────────────────
const embeddingPosts = new Set<string>();
let lastEmbedTime = 0;
const EMBED_RATE_LIMIT_MS = 10_000;
const PENDING_EMBED_MAX_ATTEMPTS = 5;

async function enqueuePendingEmbed(
  db: D1Database | undefined,
  postId: string,
  text: string,
  attempts = 0,
  error?: string,
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO pending_embeddings (post_id, text, attempts, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(post_id) DO UPDATE SET
           attempts = excluded.attempts,
           last_error = excluded.last_error`,
      )
      .bind(postId, text, attempts, error ?? null)
      .run();
  } catch (e) {
    console.error(`Failed to enqueue pending embed for post ${postId}:`, e);
  }
}

async function submitEmbedTask(
  orchestratorUrl: string,
  apiKey: string,
  baseUrl: string,
  postId: string,
  text: string,
): Promise<boolean> {
  const normalizedUrl = orchestratorUrl.replace(/\/+$/, '');
  if (!normalizedUrl || !apiKey) return false;

  const client = new FlaxiaClient({ baseUrl: `${normalizedUrl}/crowd`, apiKey });
  const callbackUrl = `${baseUrl || 'https://flaxia.app'}/api/crowd/webhook?type=vector-embed&postId=${postId}`;
  try {
    await client.submit({
      workload: 'vector-embed',
      payload: { text },
      callbackUrl,
      timeoutMs: 600000,
    } as never);
    lastEmbedTime = Date.now();
    console.log(`Embedding task submitted for post ${postId}`);
    return true;
  } catch (err) {
    console.error(`Embedding submission failed for post ${postId}:`, err);
    return false;
  }
}

async function drainPendingEmbeds(
  db: D1Database,
  orchestratorUrl: string,
  apiKey: string,
  baseUrl: string,
  opts: { maxBatch?: number; delayMs?: number; respectThrottle?: boolean } = {},
): Promise<{ submitted: number; remaining: number }> {
  const { maxBatch = 10, delayMs = 0, respectThrottle = true } = opts;
  if (!orchestratorUrl || !apiKey) {
    const { total } = (await db
      .prepare('SELECT COUNT(*) as total FROM pending_embeddings')
      .first<{ total: number }>()) || { total: 0 };
    return { submitted: 0, remaining: total };
  }

  const rows = await db
    .prepare(
      `SELECT post_id, text, attempts FROM pending_embeddings
       WHERE attempts < ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(PENDING_EMBED_MAX_ATTEMPTS, maxBatch)
    .all<{ post_id: string; text: string; attempts: number }>();

  let submitted = 0;
  for (const row of rows.results || []) {
    if (embeddingPosts.has(row.post_id)) continue;
    if (respectThrottle && Date.now() - lastEmbedTime < EMBED_RATE_LIMIT_MS) break;

    const ok = await submitEmbedTask(orchestratorUrl, apiKey, baseUrl, row.post_id, row.text);
    if (ok) {
      await db.prepare('DELETE FROM pending_embeddings WHERE post_id = ?').bind(row.post_id).run();
      submitted++;
    } else {
      await enqueuePendingEmbed(db, row.post_id, row.text, row.attempts + 1, 'submission failed');
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  const { total } = (await db
    .prepare('SELECT COUNT(*) as total FROM pending_embeddings')
    .first<{ total: number }>()) || { total: 0 };
  return { submitted, remaining: total };
}

// ─── NSFW scanning constants & helpers ────────────────────────────────────────
const IMAGE_KEY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const IMAGE_EXTENSION_LIKE = IMAGE_KEY_EXTENSIONS.map((ext) => `(lower(gif_key) LIKE '%${ext}')`).join(' OR ');

const nsfwScanPosts = new Set<string>();
let lastNsfwSubmitTime = 0;
const NSFW_RATE_LIMIT_MS = 10_000;

const NSFW_SCAN_SCHEMA = `post_id TEXT PRIMARY KEY, task_id TEXT, status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'done', 'failed')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), scanned_at TEXT`;

async function ensureNsfwScansTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS post_nsfw_scans (${NSFW_SCAN_SCHEMA})`).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_nsfw_scans_status ON post_nsfw_scans(status, created_at)').run();
  } catch (e) {
    console.error('Failed to ensure post_nsfw_scans table:', e);
  }
}

async function markNsfwScan(db: D1Database, postId: string, status: string, taskId?: string): Promise<void> {
  try {
    if (status === 'submitted') {
      await db
        .prepare('INSERT OR IGNORE INTO post_nsfw_scans (post_id, status) VALUES (?, ?)')
        .bind(postId, status)
        .run();
    } else {
      await db
        .prepare('UPDATE post_nsfw_scans SET status = ?, scanned_at = ? WHERE post_id = ?')
        .bind(status, new Date().toISOString(), postId)
        .run();
    }
    if (taskId && status === 'submitted') {
      await db.prepare('UPDATE post_nsfw_scans SET task_id = ? WHERE post_id = ?').bind(taskId, postId).run();
    }
  } catch (e) {
    console.error(`Failed to record NSFW scan state for post ${postId}:`, e);
  }
}

async function submitDetectNsfw(
  db: D1Database,
  orchestratorUrl: string,
  apiKey: string,
  baseUrl: string,
  postId: string,
  gifKey: string | null,
): Promise<void> {
  const normalizedUrl = orchestratorUrl.replace(/\/+$/, '');
  if (!normalizedUrl || !apiKey || !gifKey) return;

  const lower = gifKey.toLowerCase();
  if (!IMAGE_KEY_EXTENSIONS.some((ext) => lower.endsWith(ext))) return;

  if (nsfwScanPosts.has(postId)) return;
  nsfwScanPosts.add(postId);

  const now = Date.now();
  if (now - lastNsfwSubmitTime < NSFW_RATE_LIMIT_MS) {
    nsfwScanPosts.delete(postId);
    return;
  }
  lastNsfwSubmitTime = now;

  try {
    await ensureNsfwScansTable(db);

    const existing = (await db
      .prepare('SELECT status FROM post_nsfw_scans WHERE post_id = ?')
      .bind(postId)
      .first()) as { status: string } | null;
    if (existing?.status === 'done') return;

    const client = new FlaxiaClient({ baseUrl: `${normalizedUrl}/crowd`, apiKey });
    const callbackUrl = `${baseUrl || 'https://flaxia.app'}/api/crowd/webhook?type=nsfw&postId=${postId}`;
    const res = await client.submit({
      workload: 'nudenet',
      payload: { imageUrl: `${baseUrl || 'https://flaxia.app'}/api/images/${gifKey}` },
      callbackUrl,
      timeoutMs: 120000,
    } as never);
    await markNsfwScan(db, postId, 'submitted', res.taskId);
    console.log(`NSFW detection task submitted for post ${postId} (task ${res.taskId})`);
  } catch (err) {
    console.error(`NSFW detection submission failed for post ${postId}:`, err);
  } finally {
    nsfwScanPosts.delete(postId);
  }
}

// ─── Game description extraction ──────────────────────────────────────────────
async function extractGameDescription(
  bucket: R2Bucket,
  db: D1Database,
  payloadKey: string,
  postId: string,
): Promise<void> {
  try {
    const result = await extractFileFromZip(bucket, payloadKey, 'index.html');
    if (!result) return;
    const decoder = new TextDecoder('utf-8');
    const html = decoder.decode(result.data);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const contentMatch = (attrValue: string): string => {
      const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["']`, 'i'),
        new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`, 'i'),
      ];
      for (const pattern of patterns) {
        const m = html.match(pattern);
        if (m && m[1].trim()) return m[1].trim();
      }
      return '';
    };

    const metaDesc =
      contentMatch('description') || contentMatch('og:description') || contentMatch('twitter:description');
    const gameDescription = metaDesc || title || '';
    if (gameDescription) {
      const cleaned = gameDescription
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) {
        await db
          .prepare('UPDATE posts SET game_description = ? WHERE id = ?')
          .bind(cleaned.slice(0, 500), postId)
          .run();
      }
    }
  } catch (e) {
    console.error(`Failed to extract game description for post ${postId}:`, e);
  }
}

// ─── Auto-restore helper ──────────────────────────────────────────────────────
async function autoRestoreIfEligible(db: D1Database, postId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const result = await db
      .prepare(
        `SELECT id FROM counter_notifications
         WHERE post_id = ? AND status = 'pending' AND restore_at IS NOT NULL AND restore_at <= ?`,
      )
      .bind(postId, now)
      .first();

    if (result) {
      await db.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').bind(postId).run();
      await db
        .prepare("UPDATE counter_notifications SET status = ? WHERE post_id = ? AND status = 'pending'")
        .bind('auto_restored', postId)
        .run();
      console.log(`Auto-restored post ${postId} after counter-notification period`);
    }
  } catch (err) {
    console.error('Auto-restore check failed:', err);
  }
}

// ─── Admin Alerts ─────────────────────────────────────────────────────────────

// GET /api/admin/alerts - get unresolved admin alerts (admin only)
admin.get('/alerts', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      SELECT id, post_id, category, priority, resolved, created_at
      FROM admin_alerts
      WHERE resolved = 0
      ORDER BY CASE priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'normal' THEN 3
      END, created_at DESC
    `).all();

    return c.json({ alerts: result.results || [] });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Fetch admin alerts error:', error);
    return c.json({ error: 'Failed to fetch alerts', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/admin/alerts/:id/resolve - mark alert as resolved (admin only)
admin.post('/alerts/:id/resolve', requireAuth, requireAdmin, async (c) => {
  try {
    const alertId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    await c.env.DB.prepare('UPDATE admin_alerts SET resolved = 1 WHERE id = ?').bind(alertId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Resolve alert error:', error);
    return c.json({ error: 'Failed to resolve alert', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Admin Posts ──────────────────────────────────────────────────────────────

// POST /api/admin/posts/:id/hide - manually hide a post (admin only)
admin.post('/posts/:id/hide', requireAuth, requireAdmin, async (c) => {
  try {
    const postId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = await c.env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?').bind(postId).first();

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    await c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Hide post error:', error);
    return c.json({ error: 'Failed to hide post', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/admin/posts/:id/unhide - restore a hidden post (admin only)
admin.post('/posts/:id/unhide', requireAuth, requireAdmin, async (c) => {
  try {
    const postId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = await c.env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?').bind(postId).first();

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    await c.env.DB.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').bind(postId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Unhide post error:', error);
    return c.json({ error: 'Failed to unhide post', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/admin/posts/hidden - get hidden posts (admin only)
admin.get('/posts/hidden', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Auto-restore any expired counter-notifications
    const now = new Date().toISOString();
    const expired = await c.env.DB.prepare(
      `SELECT post_id FROM counter_notifications WHERE status = 'pending' AND restore_at IS NOT NULL AND restore_at <= ?`,
    )
      .bind(now)
      .all();

    if (expired.results && expired.results.length > 0) {
      for (const row of expired.results as Array<{ post_id: string }>) {
        await autoRestoreIfEligible(c.env.DB, row.post_id);
      }
    }

    const result = await c.env.DB.prepare(`
      SELECT posts.*, users.username, users.display_name
      FROM posts
      JOIN users ON posts.user_id = users.id
      WHERE posts.hidden = 1
      ORDER BY posts.created_at DESC
    `).all();

    return c.json({ posts: result.results || [] });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Fetch hidden posts error:', error);
    return c.json({ error: 'Failed to fetch hidden posts', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Admin Users ──────────────────────────────────────────────────────────────

// GET /api/admin/users - get all users (admin only)
admin.get('/users', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      SELECT id, username, display_name, email, created_at
      FROM users
      ORDER BY created_at DESC
    `).all();

    return c.json({ users: result.results || [] });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Fetch users error:', error);
    return c.json({ error: 'Failed to fetch users', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/admin/users/:id - delete a user account (admin only)
admin.delete('/users/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const targetUserId = c.req.param('id');
    const _adminUsername = c.get('user')?.username;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get the target user
    const targetUser = (await c.env.DB.prepare('SELECT id, username FROM users WHERE id = ?')
      .bind(targetUserId)
      .first()) as { id: string; username: string } | null;

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Check if trying to delete an admin
    if (isAdmin(c.env, targetUser.username)) {
      return c.json({ error: 'Cannot delete admin accounts' }, 403);
    }

    // Delete the user along with their posts, related data, and R2 files
    await deleteAccount(c.env, targetUser.id);

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Delete user error:', error);
    return c.json({ error: 'Failed to delete user', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Admin Counter Notifications ──────────────────────────────────────────────

// GET /api/admin/counter/pending - get pending counter-notifications (admin only)
admin.get('/counter/pending', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Auto-restore any expired counter-notifications before listing
    const now = new Date().toISOString();
    const expired = await c.env.DB.prepare(
      `SELECT post_id FROM counter_notifications WHERE status = 'pending' AND restore_at IS NOT NULL AND restore_at <= ?`,
    )
      .bind(now)
      .all();

    if (expired.results && expired.results.length > 0) {
      for (const row of expired.results as Array<{ post_id: string }>) {
        await autoRestoreIfEligible(c.env.DB, row.post_id);
      }
    }

    const result = await c.env.DB.prepare(`
      SELECT cn.*, u.username, u.display_name
      FROM counter_notifications cn
      JOIN users u ON cn.user_id = u.id
      WHERE cn.status = 'pending'
      ORDER BY cn.submitted_at ASC
    `).all();

    return c.json({ counter_notices: result.results || [] });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Fetch counter-notices error:', error);
    return c.json({ error: 'Failed to fetch counter-notices', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/admin/counter/:id/reject - reject a counter-notification (admin only)
admin.post('/counter/:id/reject', requireAuth, requireAdmin, async (c) => {
  try {
    const counterId = c.req.param('id');
    const adminId = c.get('user')?.id || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const counter = (await c.env.DB.prepare('SELECT id, status FROM counter_notifications WHERE id = ?')
      .bind(counterId)
      .first()) as { id: string; status: string } | null;

    if (!counter) {
      return c.json({ error: 'Counter-notification not found' }, 404);
    }

    if (counter.status !== 'pending') {
      return c.json({ error: 'Counter-notification is not pending' }, 400);
    }

    await c.env.DB.prepare('UPDATE counter_notifications SET status = ?, rejected_by = ?, rejected_at = ? WHERE id = ?')
      .bind('rejected_by_admin', adminId, new Date().toISOString(), counterId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Reject counter-notice error:', error);
    return c.json({ error: 'Failed to reject counter-notice', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Admin Ads ────────────────────────────────────────────────────────────────

// GET /api/admin/ads/config - get ad configuration (admin endpoint)
admin.get('/ads/config', async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user.username)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare("SELECT value FROM ad_config WHERE key = 'every_n'").first();

    if (!result) {
      return c.json({ error: 'Ad config not found' }, 404);
    }

    return c.json({ every_n: Number(result.value) });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Get ad config error:', error);
    return c.json({ error: 'Failed to get ad config', details: err.message || 'Unknown error' }, 500);
  }
});

// PATCH /api/admin/ads/config - update ad configuration (admin endpoint)
admin.patch('/ads/config', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user.username)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { every_n } = await c.req.json();

    // Validate: must be an integer >= 1
    if (!Number.isInteger(every_n) || every_n < 1) {
      return c.json({ error: 'every_n must be an integer >= 1' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare("UPDATE ad_config SET value = ? WHERE key = 'every_n'")
      .bind(String(every_n))
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to update ad config' }, 500);
    }

    return c.json({ every_n });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Update ad config error:', error);
    return c.json({ error: 'Failed to update ad config', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/admin/ads - get all ads with analytics (admin endpoint)
admin.get('/ads', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user.username)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      SELECT
        ads.id,
        ads.title,
        ads.body_text,
        ads.click_url,
        ads.payload_key,
        ads.payload_type,
        ads.thumbnail_key,
        ads.impressions,
        ads.clicks,
        ads.active,
        ads.created_at,
        ROUND(CAST(clicks AS FLOAT) / NULLIF(impressions, 0) * 100, 2) AS ctr,
        (SELECT COUNT(*) FROM ad_interactions WHERE ad_id = ads.id) AS interaction_count
      FROM ads
      ORDER BY created_at DESC
    `).all();

    if (!result.success) {
      console.error('Database query failed:', result);
      return c.json({ error: 'Failed to fetch ads' }, 500);
    }

    return c.json({ ads: result.results || [] });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Get admin ads error:', error);
    return c.json({ error: 'Failed to fetch ads', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/admin/ads - create new ad (admin endpoint)
admin.post('/ads', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user.username)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    // Generate ad ID early so it can be used for both payload and thumbnail
    const adId = nanoid();

    const contentType = c.req.header('content-type');
    let title: string,
      body_text: string,
      click_url: string,
      ad_type: string,
      payloadFile: File | undefined,
      thumbnailFile: File | undefined;

    if (contentType?.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      title = formData.get('title') as string;
      body_text = formData.get('body_text') as string;
      click_url = formData.get('click_url') as string;
      ad_type = formData.get('ad_type') as string;
      payloadFile = (formData.get('payload') as File | null) || undefined;
      thumbnailFile = (formData.get('thumbnail') as File | null) || undefined;
    } else {
      const body = await c.req.json();
      title = body.title;
      body_text = body.body_text;
      click_url = body.click_url;
      ad_type = body.ad_type;
    }

    // Validate required fields
    if (!title || !body_text) {
      return c.json({ error: 'title and body_text are required' }, 400);
    }

    // Validate ad_type
    if (!ad_type || !['self_hosted', 'admax'].includes(ad_type)) {
      return c.json({ error: 'ad_type must be either "self_hosted" or "admax"' }, 400);
    }

    // For admax ads, payload files are not allowed
    if (ad_type === 'admax' && payloadFile && payloadFile.size > 0) {
      return c.json({ error: 'Admax ads do not support payload files' }, 400);
    }

    let payload_key: string | null = null;
    let payload_type: 'zip' | 'swf' | 'gif' | 'image' | null = null;

    // Handle payload file if present (only for self_hosted ads)
    if (payloadFile && payloadFile.size > 0) {
      // Validate size <= 100MB (Cloudflare Free/Pro plan limit)
      const maxSize = 100 * 1024 * 1024;
      if (payloadFile.size > maxSize) {
        return c.json(
          {
            error:
              'Payload file must be <=100MB on Free/Pro plans. For larger files, upgrade to Business plan (200MB) or use chunked upload.',
            limit: maxSize,
            actualSize: payloadFile.size,
          },
          400,
        );
      }

      if (!c.env.BUCKET) {
        return c.json({ error: 'Storage not available' }, 500);
      }

      // Detect payload_type from file extension
      const fileName = payloadFile.name.toLowerCase();
      if (fileName.endsWith('.zip')) {
        payload_type = 'zip';
      } else if (fileName.endsWith('.swf')) {
        payload_type = 'swf';
      } else if (fileName.endsWith('.gif')) {
        payload_type = 'gif';
      } else if (fileName.endsWith('.png') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
        payload_type = 'image';
      } else {
        return c.json({ error: 'Unsupported file type. Use .zip, .swf, .gif, .png, or .jpg' }, 400);
      }

      // If zip, validate that index.html exists at root
      if (payload_type === 'zip') {
        const _fileBuffer = await payloadFile.arrayBuffer();
        // For now, we'll assume the zip is valid - in a real implementation you'd extract and check
        console.log('ZIP file validation skipped - would check for index.html at root');
      }

      // Upload to R2
      const r2Key = `ad/payload/${adId}`;

      if (payload_type === 'zip') {
        const fileBuffer = await payloadFile.arrayBuffer();
        await c.env.BUCKET.put(r2Key, fileBuffer);
      } else {
        const fileBuffer = await payloadFile.arrayBuffer();
        await c.env.BUCKET.put(r2Key, fileBuffer, {
          httpMetadata: {
            contentType: payloadFile.type,
          },
        });
      }

      payload_key = r2Key;
    }

    let thumbnail_key: string | null = null;

    // Handle thumbnail file if present
    if (thumbnailFile && thumbnailFile.size > 0) {
      // Validate thumbnail size <= 1MB
      if (thumbnailFile.size > 1024 * 1024) {
        return c.json({ error: 'Thumbnail must be <=1MB' }, 400);
      }

      // Validate thumbnail extension
      const allowedExts = ['jpg', 'jpeg', 'png', 'gif'];
      const ext = thumbnailFile.name.toLowerCase().split('.').pop();
      if (!ext || !allowedExts.includes(ext)) {
        return c.json({ error: 'Thumbnail must be .jpg, .jpeg, .png, or .gif' }, 400);
      }

      // Upload thumbnail to R2
      const thumbnailR2Key = `ad/thumbnail/${adId}.${ext}`;
      const thumbnailBuffer = await thumbnailFile.arrayBuffer();
      const thumbnailDimError = validateImageDimensions(thumbnailBuffer, thumbnailFile.type);
      if (thumbnailDimError) {
        return c.json({ error: `Thumbnail too large. ${thumbnailDimError}` }, 413);
      }
      await c.env.BUCKET.put(thumbnailR2Key, thumbnailBuffer, {
        httpMetadata: {
          contentType: thumbnailFile.type,
        },
      });

      thumbnail_key = thumbnailR2Key;
    }

    // Insert into database
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO ads (id, title, body_text, click_url, payload_key, payload_type, thumbnail_key, impressions, clicks, active, created_at, ad_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, datetime('now'), ?)
    `)
      .bind(adId, title, body_text, click_url || null, payload_key, payload_type, thumbnail_key, ad_type)
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to create ad' }, 500);
    }

    // Return created ad
    const createdAd = await c.env.DB.prepare('SELECT * FROM ads WHERE id = ?').bind(adId).first();

    return c.json({ ad: createdAd });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Create ad error:', error);
    return c.json({ error: 'Failed to create ad', details: err.message || 'Unknown error' }, 500);
  }
});

// PATCH /api/admin/ads/:id - update ad (admin endpoint)
admin.patch('/ads/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user.username)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const adId = c.req.param('id');
    const body = await c.req.json();

    if (body.click_url !== undefined && body.click_url !== null) {
      if (typeof body.click_url !== 'string') {
        return c.json({ error: 'Invalid click_url format' }, 400);
      }
      try {
        const parsed = new URL(body.click_url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return c.json({ error: 'Invalid click_url format' }, 400);
        }
      } catch {
        return c.json({ error: 'Invalid click_url format' }, 400);
      }
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Build UPDATE query dynamically
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (body.title !== undefined) {
      updates.push('title = ?');
      values.push(body.title);
    }
    if (body.body_text !== undefined) {
      updates.push('body_text = ?');
      values.push(body.body_text);
    }
    if (body.click_url !== undefined) {
      updates.push('click_url = ?');
      values.push(body.click_url);
    }
    if (body.active !== undefined) {
      updates.push('active = ?');
      values.push(body.active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    values.push(adId ?? '');

    const result = await c.env.DB.prepare(`
      UPDATE ads SET ${updates.join(', ')} WHERE id = ?
    `)
      .bind(...values)
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to update ad' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error updating ad:', error);
    return c.json({ error: 'Failed to update ad' }, 500);
  }
});

// PUT /api/admin/ads/:id - update ad (for PATCH-like updates)
admin.put('/ads/:id', requireAdmin, async (c) => {
  try {
    const adId = c.req.param('id');
    const body = await c.req.json();

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Build UPDATE query dynamically
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (body.title !== undefined) {
      updates.push('title = ?');
      values.push(body.title);
    }
    if (body.body_text !== undefined) {
      updates.push('body_text = ?');
      values.push(body.body_text);
    }
    if (body.click_url !== undefined) {
      updates.push('click_url = ?');
      values.push(body.click_url);
    }
    if (body.active !== undefined) {
      updates.push('active = ?');
      values.push(body.active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    values.push(adId ?? '');

    const result = await c.env.DB.prepare(`
      UPDATE ads SET ${updates.join(', ')} WHERE id = ?
    `)
      .bind(...values)
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to update ad' }, 500);
    }

    // Return updated ad
    const updatedAd = await c.env.DB.prepare('SELECT * FROM ads WHERE id = ?').bind(adId).first();

    return c.json({ ad: updatedAd });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Update ad error:', error);
    return c.json({ error: 'Failed to update ad', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/admin/ads/:id - delete ad (admin endpoint)
admin.delete('/ads/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user.username)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Fetch the ad to get payload_key
    const ad = await c.env.DB.prepare('SELECT payload_key FROM ads WHERE id = ?').bind(adId).first();

    if (!ad) {
      return c.json({ error: 'Ad not found' }, 404);
    }

    // Delete R2 object if payload_key exists
    if (ad.payload_key && c.env.BUCKET) {
      await c.env.BUCKET.delete(ad.payload_key as string);
    }

    // Delete the ad row (cascades to ad_interactions)
    const result = await c.env.DB.prepare('DELETE FROM ads WHERE id = ?').bind(adId).run();

    if (!result.success) {
      console.error('Database delete failed:', result);
      return c.json({ error: 'Failed to delete ad' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Delete ad error:', error);
    return c.json({ error: 'Failed to delete ad', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Admin Backfill Operations ────────────────────────────────────────────────

// POST /api/admin/backfill-game-descriptions - extract descriptions for existing game posts (admin only)
admin.post('/backfill-game-descriptions', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB || !c.env.BUCKET) {
      return c.json({ error: 'Database or bucket not available' }, 500);
    }

    const url = new URL(c.req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 1000);

    const games = (await c.env.DB.prepare(`
      SELECT id, payload_key
      FROM posts
      WHERE payload_key IS NOT NULL
        AND (payload_key LIKE '%.zip')
        AND (game_description IS NULL OR game_description = '')
      ORDER BY created_at DESC
      LIMIT ?
    `)
      .bind(limit)
      .all()) as { results: Array<{ id: string; payload_key: string }> };

    for (const game of games.results) {
      await extractGameDescription(c.env.BUCKET, c.env.DB, game.payload_key, game.id);
    }

    return c.json({ success: true, processed: games.results.length });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Backfill game descriptions error:', error);
    return c.json({ error: 'Failed to backfill game descriptions', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/admin/backfill-nsfw - submit NudeNet screening for existing image posts (admin only)
admin.post('/backfill-nsfw', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const url = new URL(c.req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);

    await ensureNsfwScansTable(c.env.DB);

    const candidates = (await c.env.DB.prepare(`
      SELECT id, gif_key
      FROM posts
      WHERE gif_key IS NOT NULL
        AND status = 'published'
        AND (${IMAGE_EXTENSION_LIKE})
        AND id NOT IN (SELECT post_id FROM post_nsfw_scans)
      ORDER BY created_at DESC
      LIMIT ?
    `)
      .bind(limit)
      .all()) as { results: Array<{ id: string; gif_key: string }> };

    let submitted = 0;
    for (const post of candidates.results) {
      await submitDetectNsfw(
        c.env.DB,
        c.env.CROWD_ORCHESTRATOR_URL,
        c.env.CROWD_API_KEY,
        c.env.BASE_URL,
        post.id,
        post.gif_key,
      );
      submitted++;
    }

    return c.json({ success: true, submitted, remaining: candidates.results.length - submitted });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Backfill nsfw error:', error);
    return c.json({ error: 'Failed to backfill nsfw screening', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/admin/backfill-embeddings - enqueue vector-embed tasks for existing
// posts that have no embedding yet, then drain as much of the backlog as the
// request budget allows. Idempotent: posts are skipped if already embedded or
// already queued.
admin.post('/backfill-embeddings', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const url = new URL(c.req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const drain = url.searchParams.get('drain') !== 'false';

    const candidates = (await c.env.DB.prepare(`
      SELECT p.id, p.text, CASE WHEN pe.post_id IS NULL THEN 0 ELSE 1 END AS pending
      FROM posts p
      LEFT JOIN post_embeddings e ON p.id = e.post_id
      LEFT JOIN pending_embeddings pe ON pe.post_id = p.id
      WHERE p.status = 'published'
        AND p.hidden = 0
        AND p.parent_id IS NULL
        AND p.text IS NOT NULL
        AND p.text != ''
        AND e.post_id IS NULL
      ORDER BY p.created_at DESC
      LIMIT ?
    `)
      .bind(limit)
      .all()) as { results: Array<{ id: string; text: string; pending: number }> };

    let enqueued = 0;
    for (const post of candidates.results) {
      // Posts already in the outbox are counted but not re-enqueued, so failed
      // retry state (attempts/last_error) is preserved.
      if (!post.pending) await enqueuePendingEmbed(c.env.DB, post.id, post.text);
      enqueued++;
    }

    const submitted = 0;
    const remaining = enqueued;
    const execCtx = (c as any).executionCtx;
    if (drain && execCtx?.waitUntil) {
      // Let the response return immediately; keep draining in the background.
      execCtx.waitUntil(
        (async () => {
          const result = await drainPendingEmbeds(
            c.env.DB,
            c.env.CROWD_ORCHESTRATOR_URL,
            c.env.CROWD_API_KEY,
            c.env.BASE_URL,
            { maxBatch: enqueued || 50, delayMs: 50, respectThrottle: false },
          ).catch((e) => {
            console.error('Backfill embed drain failed:', e);
            return { submitted: 0, remaining: enqueued };
          });
          console.log(`Backfill embed drain done: submitted=${result.submitted} remaining=${result.remaining}`);
        })(),
      );
    }

    return c.json({ success: true, enqueued, submitted, remaining });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Backfill embeddings error:', error);
    return c.json({ error: 'Failed to backfill embeddings', details: err.message || 'Unknown error' }, 500);
  }
});

export default admin;
