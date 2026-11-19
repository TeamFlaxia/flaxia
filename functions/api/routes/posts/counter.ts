import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ReportCategory } from '../../../../shared/types/post.ts';
import { addBusinessDays, requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';

export const counter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function insertAdminAlert(
  db: D1Database,
  postId: string,
  category: ReportCategory,
  priority: 'critical' | 'high' | 'normal',
) {
  const id = nanoid();
  const result = await db
    .prepare('INSERT INTO admin_alerts (id, post_id, category, priority) VALUES (?, ?, ?, ?)')
    .bind(id, postId, category, priority)
    .run();
  if (!result.success) {
    console.error('Failed to create admin alert');
  }
}

// Check and auto-restore posts where counter-notification period has expired
counter.post('/posts/:id/counter-notice', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const postId = c.req.param('id') || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }
    if (!postId) {
      return c.json({ error: 'Post ID is required' }, 400);
    }

    const post = (await c.env.DB.prepare('SELECT id, user_id, hidden FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as { id: string; user_id: string; hidden: number } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    if (post.user_id !== userId) {
      return c.json({ error: 'You can only file a counter-notice for your own posts' }, 403);
    }

    if (!post.hidden) {
      return c.json({ error: 'Post is not hidden, no counter-notice needed' }, 400);
    }

    // Check existing counter-notice
    const existing = await c.env.DB.prepare(
      'SELECT id FROM counter_notifications WHERE post_id = ? AND user_id = ? AND status = ?',
    )
      .bind(postId, userId, 'pending')
      .first();

    if (existing) {
      return c.json({ error: 'A pending counter-notice already exists for this post' }, 409);
    }

    const { name, email, address, phone, statement, consent_jurisdiction } = (await c.req.json()) as {
      name: string;
      email: string;
      address: string;
      phone: string;
      statement: boolean;
      consent_jurisdiction: boolean;
    };

    // Bound untrusted filer input before storage (stored-XSS hardening, #114;
    // also caps per-row write size). Values are rendered with textContent
    // admin-side, but length/format gates keep the table abuse-resistant.
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim() : '';
    const cleanAddress = typeof address === 'string' ? address.trim() : '';
    const cleanPhone = typeof phone === 'string' ? phone.trim() : '';
    if (!cleanName || !cleanEmail || !cleanAddress || !cleanPhone) {
      return c.json({ error: 'Name, email, address, and phone are required' }, 400);
    }
    if (
      cleanName.length > 100 ||
      cleanEmail.length > 254 ||
      cleanAddress.length > 500 ||
      cleanPhone.length > 50 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return c.json({ error: 'Invalid counter-notice fields' }, 400);
    }

    if (!statement) {
      return c.json(
        {
          error:
            'You must declare under penalty of perjury that the material was removed due to mistake or misidentification',
        },
        400,
      );
    }

    if (!consent_jurisdiction) {
      return c.json({ error: 'You must consent to the jurisdiction of the federal district court' }, 400);
    }

    const now = new Date();
    const restoreAt = addBusinessDays(now, 14);
    const id = nanoid();

    await c.env.DB.prepare(
      `INSERT INTO counter_notifications
       (id, post_id, user_id, name, email, address, phone, statement, consent_jurisdiction, submitted_at, restore_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        postId,
        userId,
        cleanName,
        cleanEmail,
        cleanAddress,
        cleanPhone,
        statement ? 1 : 0,
        consent_jurisdiction ? 1 : 0,
        now.toISOString(),
        restoreAt.toISOString(),
      )
      .run();

    // Notify admins
    await insertAdminAlert(c.env.DB, postId, 'copyright', 'high');

    return c.json({ success: true, counter_id: id, restore_at: restoreAt.toISOString() });
  } catch (error: unknown) {
    console.error('Counter-notice error:', error);
    return c.json({ error: 'Failed to file counter-notice' }, 500);
  }
});
