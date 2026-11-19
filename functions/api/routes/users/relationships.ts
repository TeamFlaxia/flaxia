import { Hono } from 'hono';
import { USER_TITLE_COLUMNS, USER_TITLE_JOIN } from '../../../lib/titles';
import { requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';

export const relationships = new Hono<{ Bindings: Bindings; Variables: Variables }>();

relationships.post('/users/:username/follow', requireAuth, async (c) => {
  try {
    const username = c.req.param('username');

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const followerId = user.id;

    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    const followeeId = targetUser.id;

    if (followerId === followeeId) {
      return c.json({ error: 'Cannot follow yourself' }, 400);
    }

    await c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)')
      .bind(followerId, followeeId)
      .run();

    const [followersResult, followingResult] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?').bind(followeeId).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(followeeId).first(),
    ]);

    return c.json({
      following: true,
      followers_count: (followersResult?.count as number) || 0,
      following_count: (followingResult?.count as number) || 0,
    });
  } catch (error: unknown) {
    console.error('Follow error:', error);
    return c.json({ error: 'Failed to follow user' }, 500);
  }
});

// DELETE /users/:username/follow - unfollow a user (protected)
relationships.delete('/users/:username/follow', requireAuth, async (c) => {
  try {
    const username = c.req.param('username');

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const followerId = user.id;

    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    const followeeId = targetUser.id;

    await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(followerId, followeeId)
      .run();

    const [followersResult, followingResult] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?').bind(followeeId).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(followeeId).first(),
    ]);

    return c.json({
      following: false,
      followers_count: (followersResult?.count as number) || 0,
      following_count: (followingResult?.count as number) || 0,
    });
  } catch (error: unknown) {
    console.error('Unfollow error:', error);
    return c.json({ error: 'Failed to unfollow user' }, 500);
  }
});

// POST /users/:username/block - block a user (protected)
relationships.post('/users/:username/block', requireAuth, async (c) => {
  try {
    const username = c.req.param('username');

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    const blockerId = c.get('user')!.id;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(username)
      .first<{ id: string }>();

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    const blockedId = targetUser.id;

    if (blockerId === blockedId) {
      return c.json({ error: 'Cannot block yourself' }, 400);
    }

    await c.env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)')
      .bind(blockerId, blockedId)
      .run();

    await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(blockerId, blockedId)
      .run();
    await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(blockedId, blockerId)
      .run();

    return c.json({ blocking: true });
  } catch (error: unknown) {
    console.error('Block error:', error);
    return c.json({ error: 'Failed to block user' }, 500);
  }
});

// DELETE /users/:username/block - unblock a user (protected)
relationships.delete('/users/:username/block', requireAuth, async (c) => {
  try {
    const username = c.req.param('username');

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    const blockerId = c.get('user')!.id;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(username)
      .first<{ id: string }>();

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    const blockedId = targetUser.id;

    await c.env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
      .bind(blockerId, blockedId)
      .run();

    return c.json({ blocking: false });
  } catch (error: unknown) {
    console.error('Unblock error:', error);
    return c.json({ error: 'Failed to unblock user' }, 500);
  }
});

// GET /users/me/blocked - get list of blocked users (protected)
relationships.get('/users/me/blocked', requireAuth, async (c) => {
  try {
    const userId = c.get('user')!.id;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, ${USER_TITLE_COLUMNS}
       FROM blocks b
       JOIN users u ON u.id = b.blocked_id
       ${USER_TITLE_JOIN}
       WHERE b.blocker_id = ?
       ORDER BY b.created_at DESC`,
    )
      .bind(userId)
      .all();

    return c.json({ users: result.results || [] });
  } catch (error: unknown) {
    console.error('Get blocked users error:', error);
    return c.json({ error: 'Failed to get blocked users' }, 500);
  }
});
