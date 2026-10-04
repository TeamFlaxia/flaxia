import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { getVapidPublicKey } from '../../lib/push';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const push = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Web Push endpoints are server-fetched on every notification, so only
 * genuine https push-service URLs are accepted (no intranet hosts).
 */
function isValidWebPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) return false;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

// GET /api/push/vapid-key - Expose VAPID public key for clients
push.get('/push/vapid-key', async (c) => {
  return c.json({ publicKey: getVapidPublicKey(c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY) });
});

// POST /api/push/register - Register a push subscription (Web Push or FCM)
push.post('/push/register', requireAuth, async (c) => {
  try {
    const user = c.get('user') as { id: string; username: string } | undefined;
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const body = (await c.req.json()) as {
      type?: string;
      endpoint: string;
      keys?: { p256dh: string; auth: string };
    };
    const subscriptionType = body.type || 'webpush';

    if (subscriptionType === 'fcm') {
      if (!body.endpoint || body.endpoint.length > 1024) {
        return c.json({ error: 'Invalid FCM token' }, 400);
      }
      const existing = await c.env.DB.prepare(
        'SELECT id, user_id FROM push_subscriptions WHERE endpoint = ? AND type = ?',
      )
        .bind(body.endpoint, 'fcm')
        .first<{ id: string; user_id: string }>();
      if (existing) {
        // An endpoint belongs to whoever registered it first: never rebind
        // another user's subscription to the caller (push hijacking).
        if (existing.user_id !== user.id) {
          return c.json({ error: 'Endpoint already registered' }, 409);
        }
        await c.env.DB.prepare(
          "UPDATE push_subscriptions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        )
          .bind(existing.id)
          .run();
      } else {
        await c.env.DB.prepare(
          'INSERT INTO push_subscriptions (id, user_id, type, endpoint, auth_key, p256dh_key) VALUES (?, ?, ?, ?, ?, ?)',
        )
          .bind(nanoid(), user.id, 'fcm', body.endpoint, '', '')
          .run();
      }
      return c.json({ ok: true });
    }

    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return c.json({ error: 'Invalid subscription' }, 400);
    }
    if (!isValidWebPushEndpoint(body.endpoint)) {
      return c.json({ error: 'Invalid subscription endpoint' }, 400);
    }
    if (body.keys.p256dh.length > 256 || body.keys.auth.length > 256) {
      return c.json({ error: 'Invalid subscription keys' }, 400);
    }
    const existing = await c.env.DB.prepare('SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?')
      .bind(body.endpoint)
      .first<{ id: string; user_id: string }>();
    if (existing) {
      if (existing.user_id !== user.id) {
        return c.json({ error: 'Endpoint already registered' }, 409);
      }
      await c.env.DB.prepare(
        "UPDATE push_subscriptions SET auth_key = ?, p256dh_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      )
        .bind(body.keys.auth, body.keys.p256dh, existing.id)
        .run();
    } else {
      await c.env.DB.prepare(
        'INSERT INTO push_subscriptions (id, user_id, type, endpoint, auth_key, p256dh_key) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(nanoid(), user.id, 'webpush', body.endpoint, body.keys.auth, body.keys.p256dh)
        .run();
    }
    return c.json({ ok: true });
  } catch (e) {
    console.error('Failed to register push subscription:', e);
    return c.json({ error: 'Failed to register push subscription' }, 500);
  }
});

// POST /api/push/unregister - Remove a Web Push subscription (protected)
push.post('/push/unregister', requireAuth, async (c) => {
  try {
    const user = c.get('user') as { id: string } | undefined;
    const { endpoint } = (await c.req.json()) as { endpoint: string };
    if (!endpoint) return c.json({ error: 'Missing endpoint' }, 400);
    // Scoped to the caller: one user must not silence another's notifications.
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
      .bind(endpoint, user?.id || '')
      .run();
    return c.json({ ok: true });
  } catch (e) {
    console.error('Failed to unregister push subscription:', e);
    return c.json({ error: 'Failed to unregister push subscription' }, 500);
  }
});

// GET /api/notifications - fetch notifications (protected)
push.get('/notifications', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      SELECT 
        n.id,
        n.type,
        n.post_id,
        n.read,
        n.created_at,
        n.actor_id,
        n.actor_data,
        SUBSTR(p.text, 1, 50) as post_text_preview,
        u.username as actor_username,
        u.display_name as actor_display_name,
        u.avatar_key as actor_avatar_key, u.badge_type as actor_badge_type
      FROM (
        SELECT * FROM notifications 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 20
      ) n
      LEFT JOIN posts p ON n.post_id = p.id
      LEFT JOIN users u ON n.actor_id = u.id
    `)
      .bind(userId)
      .all();

    if (!result.success) {
      return c.json({ error: 'Failed to fetch notifications' }, 500);
    }

    const unreadResult = (await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0',
    )
      .bind(userId)
      .first()) as { count: number };

    const rows = result.results || [];

    const allActorIds = new Set<string>();
    for (const row of rows) {
      if (row.type === 'fresh' && row.actor_data) {
        try {
          const ids = JSON.parse(row.actor_data as string);
          if (Array.isArray(ids)) ids.forEach((id: string) => void allActorIds.add(id));
        } catch {}
      }
    }

    const actorUserMap = new Map<string, Record<string, unknown>>();
    if (allActorIds.size > 0) {
      const userRows = await c.env.DB.prepare(`
        SELECT id, username, display_name, avatar_key, badge_type FROM users WHERE id IN (${Array.from(allActorIds)
          .map(() => '?')
          .join(',')})
      `)
        .bind(...Array.from(allActorIds))
        .all();
      for (const u of (userRows.results || []) as Array<Record<string, unknown>>) {
        actorUserMap.set(u.id as string, u);
      }
    }

    const notifications = rows.map((row: Record<string, unknown>) => {
      const notif: Record<string, unknown> = {
        id: row.id,
        type: row.type,
        post_id: row.post_id,
        post_text_preview: row.post_text_preview,
        actor: row.actor_username
          ? {
              username: row.actor_username,
              display_name: row.actor_display_name,
              avatar_key: row.actor_avatar_key,
              badge_type: (row.actor_badge_type as string | null) ?? null,
            }
          : undefined,
        actor_id: row.actor_id,
        actor_data: row.actor_data,
        read: row.read === 1,
        created_at: row.created_at,
      };

      if (row.type === 'fresh' && row.actor_data) {
        try {
          const ids = JSON.parse(row.actor_data as string);
          if (Array.isArray(ids) && ids.length > 1) {
            notif.actors = ids
              .map((id: string) => {
                const u = actorUserMap.get(id);
                return u
                  ? {
                      username: u.username,
                      display_name: u.display_name,
                      avatar_key: u.avatar_key,
                      badge_type: (u.badge_type as string | null) ?? null,
                    }
                  : null;
              })
              .filter(Boolean);
          }
        } catch {}
      }

      return notif;
    });

    return c.json({
      notifications,
      unread_count: unreadResult?.count || 0,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Fetch notifications error:', error);
    return c.json({ error: 'Failed to fetch notifications', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/notifications/read-all - mark all notifications as read (protected)
push.post('/notifications/read-all', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    await c.env.DB.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').bind(userId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Mark all read error:', error);
    return c.json({ error: 'Failed to mark notifications as read', details: err.message || 'Unknown error' }, 500);
  }
});

export default push;
