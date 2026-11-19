import { type Context, Hono } from 'hono';
import { deleteAccount } from '../../lib/account-deletion';
import { isAdmin } from '../../lib/admin.ts';
import { getAdminAnalytics, parseAnalyticsDays } from '../../lib/admin-analytics';
import {
  applyNsfwTags,
  drainPendingEmbeds,
  enqueuePendingEmbed,
  ensureNsfwScansTable,
  submitDetectNsfw,
} from '../../lib/crowd';
import { adminAuthAccount, revokeAuthUserGrants } from '../../lib/flaxia-auth';
import {
  addBlocklistEntry,
  listBlocklist,
  removeBlocklistEntry,
  validateBlocklistEntry,
} from '../../lib/scan/blocklist';
import { rescreenQuarantinedObject } from '../../lib/scan/rescreen';
import { extractFileFromZip } from '../../lib/wvfs-zip-server.ts';
import { requireAdmin, requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';
import { ads } from './admin/ads.ts';

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

admin.get('/access', requireAuth, requireAdmin, (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ allowed: true });
});

// Return aggregate metrics and public labels for ranked games; never cache analytics by a CDN.
admin.get('/analytics', requireAuth, requireAdmin, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const days = parseAnalyticsDays(c.req.query('days'));
  if (days === null) return c.json({ error: 'days must be 7, 30, or 90' }, 400);
  if (!c.env.DB) return c.json({ error: 'Database not available' }, 503);
  try {
    return c.json(await getAdminAnalytics(c.env.DB, days));
  } catch (error: unknown) {
    console.error('Admin analytics error:', error);
    return c.json({ error: 'Failed to fetch analytics' }, 500);
  }
});

// ─── NSFW scanning constants & helpers ────────────────────────────────────────
const IMAGE_KEY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const IMAGE_EXTENSION_LIKE = IMAGE_KEY_EXTENSIONS.map((ext) => `(lower(gif_key) LIKE '%${ext}')`).join(' OR ');

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
    console.error('Fetch admin alerts error:', error);
    return c.json({ error: 'Failed to fetch alerts' }, 500);
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
    console.error('Resolve alert error:', error);
    return c.json({ error: 'Failed to resolve alert' }, 500);
  }
});

// ─── Admin Posts ──────────────────────────────────────────────────────────────

// POST /api/admin/posts/:id/nsfw - apply the existing NSFW filter without waiting for reports or scans.
admin.post('/posts/:id/nsfw', requireAuth, requireAdmin, async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not available' }, 503);
  try {
    const postId = c.req.param('id');
    if (!postId) return c.json({ error: 'Post ID is required' }, 400);
    const post = await c.env.DB.prepare('SELECT hashtags FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ hashtags: string | null }>();
    if (!post) return c.json({ error: 'Post not found' }, 404);

    const hashtags: string[] = JSON.parse(post.hashtags || '[]');
    if (hashtags.some((tag) => tag.toLowerCase() === 'nsfw')) {
      return c.json({ success: true, changed: false });
    }
    if (!(await applyNsfwTags(c.env.DB, postId, ['nsfw']))) {
      return c.json({ error: 'Failed to mark post as NSFW' }, 500);
    }
    return c.json({ success: true, changed: true });
  } catch (error: unknown) {
    console.error('Mark post NSFW error:', error);
    return c.json({ error: 'Failed to mark post as NSFW' }, 500);
  }
});

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
    console.error('Hide post error:', error);
    return c.json({ error: 'Failed to hide post' }, 500);
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
    console.error('Unhide post error:', error);
    return c.json({ error: 'Failed to unhide post' }, 500);
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
    console.error('Fetch hidden posts error:', error);
    return c.json({ error: 'Failed to fetch hidden posts' }, 500);
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
      SELECT id, username, display_name, email, created_at, role, frozen_at, frozen_reason
      FROM users
      ORDER BY created_at DESC
    `).all<{
      id: string;
      username: string;
      display_name: string;
      email: string;
      created_at: string;
      role: string | null;
      frozen_at: string | null;
      frozen_reason: string | null;
    }>();

    const users = (result.results || []).map((user) => ({
      ...user,
      is_admin: isAdmin(c.env, user),
    }));
    return c.json({ users });
  } catch (error: unknown) {
    console.error('Fetch users error:', error);
    return c.json({ error: 'Failed to fetch users' }, 500);
  }
});

async function setAccountFrozen(c: Context<{ Bindings: Bindings; Variables: Variables }>, frozen: boolean) {
  if (!c.env.DB) {
    return c.json({ error: 'Database not available' }, 500);
  }

  const targetUser = await c.env.DB.prepare('SELECT id, username, role, frozen_at FROM users WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; username: string; role: string | null; frozen_at: string | null }>();

  if (!targetUser) {
    return c.json({ error: 'User not found' }, 404);
  }
  if (isAdmin(c.env, targetUser)) {
    return c.json({ error: 'Cannot freeze admin accounts' }, 403);
  }
  if (!frozen && !targetUser.frozen_at) {
    return c.json({ error: 'Account is not frozen' }, 409);
  }

  let reason: string | null = null;
  if (frozen) {
    const body = await c.req.json<{ reason?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'A freeze reason of 1 to 500 characters is required' }, 400);
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) {
      return c.json({ error: 'A freeze reason of 1 to 500 characters is required' }, 400);
    }
    reason = body.reason.trim();
  }

  // The app cannot revoke Auth grants by deleting its old local sessions.
  // Freeze/unfreeze at Auth first so the identity authority agrees with the
  // local moderation state, then revoke both sides. The Auth freeze also drops
  // its sessions, which invalidates every previously minted grant.
  // Provisioned accounts already exist at Auth even before they are linked.
  const linked = await c.env.DB.prepare(
    'SELECT 1 FROM flaxia_auth_links WHERE user_id = ? UNION ALL SELECT 1 FROM flaxia_auth_provisioning WHERE user_id = ? LIMIT 1',
  )
    .bind(targetUser.id, targetUser.id)
    .first();
  if (linked) {
    const result = await adminAuthAccount(c.env, frozen ? 'freeze' : 'unfreeze', targetUser.id, reason ?? undefined);
    if (result === 'unavailable') return c.json({ error: 'Auth account update unavailable' }, 503);
    if (!(await revokeAuthUserGrants(c.env, targetUser.id)))
      return c.json({ error: 'Auth revocation unavailable' }, 503);
  }

  const frozenAt = frozen ? new Date().toISOString() : null;
  const statements = frozen
    ? [
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO account_freeze_posts (user_id, post_id, hidden_before_freeze) SELECT user_id, id, hidden FROM posts WHERE user_id = ?',
        ).bind(targetUser.id),
        c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE user_id = ?').bind(targetUser.id),
        c.env.DB.prepare('UPDATE users SET frozen_at = ?, frozen_reason = ? WHERE id = ?').bind(
          frozenAt,
          reason,
          targetUser.id,
        ),
      ]
    : [
        c.env.DB.prepare(
          `UPDATE posts SET hidden = (
             SELECT hidden_before_freeze FROM account_freeze_posts
             WHERE account_freeze_posts.user_id = posts.user_id AND account_freeze_posts.post_id = posts.id
           ) WHERE user_id = ? AND EXISTS (
             SELECT 1 FROM account_freeze_posts
             WHERE account_freeze_posts.user_id = posts.user_id AND account_freeze_posts.post_id = posts.id
           )`,
        ).bind(targetUser.id),
        c.env.DB.prepare('DELETE FROM account_freeze_posts WHERE user_id = ?').bind(targetUser.id),
        c.env.DB.prepare('UPDATE users SET frozen_at = NULL, frozen_reason = NULL WHERE id = ?').bind(targetUser.id),
      ];
  statements.push(
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetUser.id),
    c.env.DB.prepare('DELETE FROM srp_handshakes WHERE user_id = ?').bind(targetUser.id),
  );
  await c.env.DB.batch(statements);

  return c.json({ success: true, frozen_at: frozenAt, frozen_reason: reason });
}

// Freezing clears sessions and pending SRP logins. Unfreezing requires a fresh login.
admin.post('/users/:id/freeze', requireAuth, requireAdmin, (c) => setAccountFrozen(c, true));
admin.post('/users/:id/unfreeze', requireAuth, requireAdmin, (c) => setAccountFrozen(c, false));

// DELETE /api/admin/users/:id - delete a user account (admin only)
admin.delete('/users/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const targetUserId = c.req.param('id');
    const _adminUsername = c.get('user')?.username;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get the target user
    const targetUser = (await c.env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?')
      .bind(targetUserId)
      .first()) as { id: string; username: string; role: string | null } | null;

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Check if trying to delete an admin
    if (isAdmin(c.env, targetUser)) {
      return c.json({ error: 'Cannot delete admin accounts' }, 403);
    }

    // A linked identity must be deleted at Auth first. Deleting only the local
    // profile would leave the Auth account able to create a new profile with
    // the same username/email, and the link guard would abort the batch.
    const linked = await c.env.DB.prepare(
      'SELECT 1 FROM flaxia_auth_links WHERE user_id = ? UNION ALL SELECT 1 FROM flaxia_auth_provisioning WHERE user_id = ? LIMIT 1',
    )
      .bind(targetUser.id, targetUser.id)
      .first();
    if (linked) {
      const result = await adminAuthAccount(c.env, 'delete', targetUser.id);
      if (result === 'unavailable') return c.json({ error: 'Auth account deletion unavailable' }, 503);
    }

    // Delete the user along with their posts, related data, and R2 files
    await deleteAccount(c.env, targetUser.id, undefined, false, Boolean(linked));

    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Delete user error:', error);
    return c.json({ error: 'Failed to delete user' }, 500);
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
    console.error('Fetch counter-notices error:', error);
    return c.json({ error: 'Failed to fetch counter-notices' }, 500);
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
    console.error('Reject counter-notice error:', error);
    return c.json({ error: 'Failed to reject counter-notice' }, 500);
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
    console.error('Backfill game descriptions error:', error);
    return c.json({ error: 'Failed to backfill game descriptions' }, 500);
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

    // One candidate per (post, image): a 4-image post needs 4 verdicts and
    // post_nsfw_scans now tracks them individually.
    const candidates = (await c.env.DB.prepare(`
      SELECT post_id, media_key
      FROM (
        SELECT id AS post_id, gif_key AS media_key, created_at
        FROM posts
        WHERE gif_key IS NOT NULL
          AND status = 'published'
          AND (${IMAGE_EXTENSION_LIKE})
        UNION ALL
        SELECT p.id, a.r2_key AS media_key, p.created_at
        FROM posts p
        JOIN post_attachments a ON a.post_id = p.id AND a.kind = 'image'
        WHERE p.status = 'published'
      ) cand
      WHERE NOT EXISTS (
        SELECT 1 FROM post_nsfw_scans s
        WHERE s.post_id = cand.post_id AND s.media_key = cand.media_key
          AND (s.status = 'submitted' OR (s.status = 'done' AND s.ai_passed IS NOT NULL))
      )
      GROUP BY post_id, media_key
      ORDER BY MAX(created_at) DESC
      LIMIT ?
    `)
      .bind(limit)
      .all()) as { results: Array<{ post_id: string; media_key: string }> };

    // The global 10s ceiling lets one image through per call by default;
    // ?throttle=false is the admin's explicit way to flush a backlog.
    const respectThrottle = url.searchParams.get('throttle') !== 'false';
    let submitted = 0;
    for (const cand of candidates.results) {
      if (
        await submitDetectNsfw(c.env.DB, c.env, cand.post_id, cand.media_key, {
          respectThrottle,
          recheckCompleted: true,
        })
      )
        submitted++;
    }

    return c.json({ success: true, submitted, remaining: candidates.results.length - submitted });
  } catch (error: unknown) {
    console.error('Backfill nsfw error:', error);
    return c.json({ error: 'Failed to backfill nsfw screening' }, 500);
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
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 2_147_483_647);
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
        AND (e.post_id IS NULL OR e.source_sha IS NULL OR COALESCE(e.dimensions, 0) != 768)
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
          const result = await drainPendingEmbeds(c.env.DB, c.env, {
            maxBatch: enqueued || 50,
            delayMs: 50,
            respectThrottle: false,
          }).catch((e) => {
            console.error('Backfill embed drain failed:', e);
            return { submitted: 0, remaining: enqueued };
          });
          console.log(`Backfill embed drain done: submitted=${result.submitted} remaining=${result.remaining}`);
        })(),
      );
    }

    return c.json({ success: true, enqueued, submitted, remaining });
  } catch (error: unknown) {
    console.error('Backfill embeddings error:', error);
    return c.json({ error: 'Failed to backfill embeddings' }, 500);
  }
});

// GET /auth-migration — progress of the plaintext-password retirement.
//
// Two independent counters, because they retire at different times:
//   no_srp       accounts that can only use the deprecated POST /auth/login.
//                Hits 0 as every remaining legacy account signs in once.
//   plaintext_hash accounts still carrying password_hash (PBKDF2). Non-empty
//                for the same set; it is blanked by the upgrade itself.
// `cutoffReached` is the signal that POST /api/auth/login can be deleted (see
// the comment on that route). srp_v1 rows are verifiers still derived with a
// single SHA-256; they migrate at the next password-holding event.
admin.get('/auth-migration', requireAuth, requireAdmin, async (c) => {
  try {
    const row = await c.env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN password_hash <> '' THEN 1 ELSE 0 END), 0) AS plaintext_hash,
         COALESCE(SUM(CASE WHEN srp_salt IS NULL THEN 1 ELSE 0 END), 0) AS no_srp,
         COALESCE(SUM(CASE WHEN srp_kdf = 'sha256-v1' THEN 1 ELSE 0 END), 0) AS srp_v1,
         COALESCE(SUM(CASE WHEN srp_kdf = 'pbkdf2-600k-v2' THEN 1 ELSE 0 END), 0) AS srp_v2,
         COALESCE(SUM(CASE WHEN srp_salt IS NOT NULL AND srp_kdf IS NULL THEN 1 ELSE 0 END), 0) AS srp_kdf_unlabelled
       FROM users`,
    ).first<{
      total: number;
      plaintext_hash: number;
      no_srp: number;
      srp_v1: number;
      srp_v2: number;
      srp_kdf_unlabelled: number;
    }>();

    const stats = row ?? {
      total: 0,
      plaintext_hash: 0,
      no_srp: 0,
      srp_v1: 0,
      srp_v2: 0,
      srp_kdf_unlabelled: 0,
    };
    return c.json({ ...stats, cutoff_reached: stats.plaintext_hash === 0 && stats.no_srp === 0 });
  } catch (error: unknown) {
    console.error('Auth migration stats error:', error);
    return c.json({ error: 'Failed to read migration stats' }, 500);
  }
});

// ─── File blocklist ──────────────────────────────────────────────────────────

// POST /api/admin/rescreen-quarantined — retry skipped image scans after confirming
// their current R2 bytes still match the D1 row.
admin.post('/rescreen-quarantined', requireAuth, requireAdmin, async (c) => {
  if (!c.env.DB || !c.env.BUCKET) return c.json({ error: 'Database or bucket unavailable' }, 500);

  let body: { limit?: unknown } = {};
  try {
    body = await c.req.json<{ limit?: unknown }>();
  } catch {
    // An empty request body is allowed; the default batch is small.
  }
  const requested = typeof body.limit === 'number' ? body.limit : Number(body.limit ?? 25);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 100) : 25;

  try {
    const rows = await c.env.DB.prepare(
      `SELECT r2_key FROM file_scans
       WHERE status = 'skipped' AND detail IN ('too_large', 'orchestrator_unconfigured')
         AND kind = 'image'
       ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(limit)
      .all<{ r2_key: string }>();

    const results: Record<string, number> = {};
    for (const row of rows.results ?? []) {
      const result = await rescreenQuarantinedObject(c.env.DB, c.env.BUCKET, c.env, row.r2_key);
      results[result] = (results[result] ?? 0) + 1;
    }
    return c.json({ success: true, considered: rows.results?.length ?? 0, results });
  } catch (error: unknown) {
    console.error('Quarantined media rescreen error:', error);
    return c.json({ error: 'Failed to rescreen quarantined media' }, 500);
  }
});

// GET /api/admin/file-blocklist — list all entries.
admin.get('/file-blocklist', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }
    const entries = await listBlocklist(c.env.DB);
    return c.json({ entries });
  } catch (error: unknown) {
    console.error('File blocklist list error:', error);
    return c.json({ error: 'Failed to list blocklist' }, 500);
  }
});

// POST /api/admin/file-blocklist — add (or refresh) one entry.
admin.post('/file-blocklist', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }
    const body = await c.req.json<{ kind?: unknown; value?: unknown; signature?: unknown; reason?: unknown }>();
    const parsed = validateBlocklistEntry(body.kind, body.value);
    if ('error' in parsed) {
      return c.json({ error: parsed.error }, 400);
    }
    await addBlocklistEntry(c.env.DB, {
      ...parsed,
      signature: typeof body.signature === 'string' ? body.signature.slice(0, 200) : null,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
      addedBy: c.get('user')?.id ?? 'admin',
    });
    return c.json({ ok: true, ...parsed }, 201);
  } catch (error: unknown) {
    console.error('File blocklist add error:', error);
    return c.json({ error: 'Failed to add blocklist entry' }, 500);
  }
});

// DELETE /api/admin/file-blocklist/:id — remove one entry.
admin.delete('/file-blocklist/:id', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid id' }, 400);
    }
    const removed = await removeBlocklistEntry(c.env.DB, id);
    if (!removed) {
      return c.json({ error: 'Entry not found' }, 404);
    }
    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('File blocklist delete error:', error);
    return c.json({ error: 'Failed to delete blocklist entry' }, 500);
  }
});

admin.route('/', ads);

export default admin;
