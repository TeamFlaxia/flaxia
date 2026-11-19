import { type Context, Hono } from 'hono';
import { deleteAccount } from '../../../lib/account-deletion';
import { isAdmin } from '../../../lib/admin.ts';
import { adminAuthAccount, revokeAuthUserGrants } from '../../../lib/flaxia-auth';
import { requireAdmin, requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';
import { autoRestoreIfEligible } from './post-helpers.ts';

export const users = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Admin Users ──────────────────────────────────────────────────────────────

// GET /api/admin/users - get all users (admin only)
users.get('/users', requireAuth, requireAdmin, async (c) => {
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
users.post('/users/:id/freeze', requireAuth, requireAdmin, (c) => setAccountFrozen(c, true));
users.post('/users/:id/unfreeze', requireAuth, requireAdmin, (c) => setAccountFrozen(c, false));

// DELETE /api/admin/users/:id - delete a user account (admin only)
users.delete('/users/:id', requireAuth, requireAdmin, async (c) => {
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
users.get('/counter/pending', requireAuth, requireAdmin, async (c) => {
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
users.post('/counter/:id/reject', requireAuth, requireAdmin, async (c) => {
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
