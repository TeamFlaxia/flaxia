import { Hono } from 'hono';
import { applyNsfwTags } from '../../../lib/crowd';
import { requireAdmin, requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';
import { autoRestoreIfEligible } from './post-helpers.ts';

export const moderation = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Admin Alerts ─────────────────────────────────────────────────────────────

// GET /api/admin/alerts - get unresolved admin alerts (admin only)
moderation.get('/alerts', requireAuth, requireAdmin, async (c) => {
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
moderation.post('/alerts/:id/resolve', requireAuth, requireAdmin, async (c) => {
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
moderation.post('/posts/:id/nsfw', requireAuth, requireAdmin, async (c) => {
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
moderation.post('/posts/:id/hide', requireAuth, requireAdmin, async (c) => {
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
moderation.post('/posts/:id/unhide', requireAuth, requireAdmin, async (c) => {
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
moderation.get('/posts/hidden', requireAuth, requireAdmin, async (c) => {
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
