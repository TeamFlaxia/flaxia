import { Hono } from 'hono';
import { enrichPostsWithAttachments } from '../../../lib/attachments';
import { getMeWithSession, getSessionToken } from '../../../lib/auth';
import { clampLimit } from '../../../lib/pagination';
import { USER_TITLE_COLUMNS, USER_TITLE_JOIN } from '../../../lib/titles';
import { batchGetFreshAndBookmarkStatus, requireAuth } from '../../helpers';
import type { Bindings, PostRow, Variables } from '../../types';
import { enrichPostsWithReactions, RECOMMENDED_SELECT } from './helpers.ts';

export const profiles = new Hono<{ Bindings: Bindings; Variables: Variables }>();

profiles.get('/users/:username', async (c) => {
  try {
    const username = c.req.param('username');
    c.header('Cache-Control', 'private, no-store');

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = await c.env.DB.prepare(`
      SELECT u.id, u.username, u.display_name, u.bio, u.avatar_key, u.badge_type, u.name_color, u.header_key,
             u.created_at, u.pinned_post_id, u.frozen_at, u.frozen_reason, u.equipped_title_id,
             t.name AS title_name, t.name_ja AS title_name_ja,
             t.description AS title_description, t.description_ja AS title_description_ja, t.icon AS title_icon
      FROM users u
      LEFT JOIN titles t ON t.id = u.equipped_title_id
      WHERE u.username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (user.frozen_at) {
      return c.json({
        user: {
          frozen: true,
          frozen_reason: user.frozen_reason ?? '',
          username: user.username,
          display_name: user.display_name,
          avatar_key: user.avatar_key,
          badge_type: user.badge_type,
          name_color: user.name_color,
          header_key: user.header_key,
        },
      });
    }

    const [followersResult, followingResult, postsResult] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?').bind(user.id).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(user.id).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM posts WHERE user_id = ?').bind(user.id).first(),
    ]);

    const followers_count = (followersResult?.count as number) || 0;
    const following_count = (followingResult?.count as number) || 0;
    const posts_count = (postsResult?.count as number) || 0;

    let is_following = false;
    let is_blocked = false;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token) : null;
    if (sessionData && sessionData.user.id !== user.id) {
      const followResult = await c.env.DB.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?')
        .bind(sessionData.user.id, user.id)
        .first();
      is_following = followResult !== null;
      const blockResult = await c.env.DB.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
        .bind(sessionData.user.id, user.id)
        .first();
      is_blocked = blockResult !== null;
    }

    return c.json({
      user: {
        ...user,
        followers_count,
        following_count,
        posts_count,
        is_following,
        is_blocked,
      },
    });
  } catch (error: unknown) {
    console.error('Get user error:', error);
    return c.json({ error: 'Failed to get user' }, 500);
  }
});

// GET /users/:username/pinned - get the pinned post for a user (public)
profiles.get('/users/:username/pinned', async (c) => {
  try {
    const username = c.req.param('username');
    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = await c.env.DB.prepare(
      'SELECT id, pinned_post_id, frozen_at FROM users WHERE username = ? COLLATE NOCASE',
    )
      .bind(username)
      .first<{ id: string; pinned_post_id: string | null; frozen_at: string | null }>();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (user.frozen_at) return c.json({ error: 'User not found' }, 404);

    if (!user.pinned_post_id) {
      return c.json({ post: null });
    }

    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token) : null;
    const currentUserId = sessionData?.user.id ?? null;

    const row = await c.env.DB.prepare(
      `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0`,
    )
      .bind(user.pinned_post_id)
      .first();

    if (!row) {
      return c.json({ post: null });
    }

    const posts = [row as unknown as PostRow];
    await enrichPostsWithReactions(posts, c.env.DB, currentUserId);
    await enrichPostsWithAttachments(posts, c.env.DB);
    if (currentUserId) {
      const { freshed, reloaded, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, [
        posts[0].id,
      ]);
      posts[0].is_freshed = freshed.has(posts[0].id);
      posts[0].is_reloaded = reloaded.has(posts[0].id);
      posts[0].is_bookmarked = bookmarked.has(posts[0].id);
    }

    return c.json({ post: posts[0] });
  } catch (error: unknown) {
    console.error('Get pinned post error:', error);
    return c.json({ error: 'Failed to get pinned post' }, 500);
  }
});

// POST /profile/pin - pin a post to the current user's profile (protected)
profiles.post('/profile/pin', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const body = (await c.req.json<{ postId?: string | null }>().catch(() => ({}))) as {
      postId?: string | null;
    };
    const postId = body.postId ?? null;

    if (postId) {
      const post = await c.env.DB.prepare(
        "SELECT id, user_id FROM posts WHERE id = ? AND status = 'published' AND hidden = 0",
      )
        .bind(postId)
        .first<{ id: string; user_id: string }>();

      if (!post || post.user_id !== user.id) {
        return c.json({ error: 'Post not found or not owned by you' }, 403);
      }
    }

    await c.env.DB.prepare('UPDATE users SET pinned_post_id = ? WHERE id = ?').bind(postId, user.id).run();

    return c.json({ ok: true, pinned_post_id: postId });
  } catch (error: unknown) {
    console.error('Pin post error:', error);
    return c.json({ error: 'Failed to pin post' }, 500);
  }
});

// DELETE /profile/pin - unpin the current user's profile post (protected)
profiles.delete('/profile/pin', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    await c.env.DB.prepare('UPDATE users SET pinned_post_id = NULL WHERE id = ?').bind(user.id).run();

    return c.json({ ok: true, pinned_post_id: null });
  } catch (error: unknown) {
    console.error('Unpin post error:', error);
    return c.json({ error: 'Failed to unpin post' }, 500);
  }
});

// GET /users/:username/followers - get paginated followers list
profiles.get('/users/:username/followers', async (c) => {
  try {
    const username = c.req.param('username');
    const cursor = c.req.query('cursor');
    const limit = clampLimit(c.req.query('limit'), 20, 50);

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, badge_type, created_at, frozen_at
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (user.frozen_at) return c.json({ error: 'User not found' }, 404);

    let currentUserId: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token) : null;
    if (sessionData) {
      currentUserId = sessionData.user.id;
    }

    let query = `
      SELECT 
        u.id, u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.language as author_language,
        u.created_at, ${USER_TITLE_COLUMNS}
      FROM follows f
      JOIN users u ON f.follower_id = u.id
      ${USER_TITLE_JOIN}
      WHERE f.followee_id = ?
    `;

    const params: Array<string | null> = [user.id as string];

    if (cursor) {
      query += ` AND u.username > ?`;
      params.push(cursor);
    }

    query += ` ORDER BY u.username ASC LIMIT ?`;
    params.push(String(limit + 1));

    const results = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!results.results) {
      return c.json({ users: [], next_cursor: null, has_more: false });
    }

    const userRows = results.results.slice(0, limit);
    const hasMore = results.results.length > limit;
    const nextCursor = hasMore ? (userRows[userRows.length - 1] as { username: string }).username : null;

    const userIds = userRows.map((u: Record<string, unknown>) => u.id as string);
    const placeholders = userIds.map(() => '?').join(',');
    const [followersCounts, followingCounts] = await Promise.all([
      c.env.DB.prepare(
        `SELECT followee_id, COUNT(*) as cnt FROM follows WHERE followee_id IN (${placeholders}) GROUP BY followee_id`,
      )
        .bind(...userIds)
        .all<{ followee_id: string; cnt: number }>(),
      c.env.DB.prepare(
        `SELECT follower_id, COUNT(*) as cnt FROM follows WHERE follower_id IN (${placeholders}) GROUP BY follower_id`,
      )
        .bind(...userIds)
        .all<{ follower_id: string; cnt: number }>(),
    ]);

    const followersMap = new Map((followersCounts.results || []).map((r) => [r.followee_id, r.cnt]));
    const followingMap = new Map((followingCounts.results || []).map((r) => [r.follower_id, r.cnt]));

    const usersList = userRows.map((u: Record<string, unknown>) => ({
      ...u,
      followers_count: followersMap.get(u.id as string) || 0,
      following_count: followingMap.get(u.id as string) || 0,
      is_following: currentUserId ? (u.id === currentUserId ? false : null) : false,
    }));

    if (currentUserId) {
      const followCheck = await c.env.DB.prepare(
        `SELECT followee_id FROM follows WHERE follower_id = ? AND followee_id IN (${placeholders})`,
      )
        .bind(currentUserId, ...userIds)
        .all<{ followee_id: string }>();
      const followingSet = new Set((followCheck.results || []).map((r) => r.followee_id));
      usersList.forEach((u: Record<string, unknown>) => {
        u.is_following = followingSet.has(u.id as string);
      });
    }

    return c.json({
      users: usersList,
      next_cursor: nextCursor,
      has_more: hasMore,
    });
  } catch (error: unknown) {
    console.error('Get followers error:', error);
    return c.json({ error: 'Failed to get followers' }, 500);
  }
});

// GET /users/:username/following - get paginated following list
profiles.get('/users/:username/following', async (c) => {
  try {
    const username = c.req.param('username');
    const cursor = c.req.query('cursor');
    const limit = clampLimit(c.req.query('limit'), 20, 50);

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, badge_type, created_at, frozen_at
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    if (user.frozen_at) return c.json({ error: 'User not found' }, 404);

    let currentUserId: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token) : null;
    if (sessionData) {
      currentUserId = sessionData.user.id;
    }

    let query = `
      SELECT 
        u.id, u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.language as author_language,
        u.created_at, ${USER_TITLE_COLUMNS}
      FROM follows f
      JOIN users u ON f.followee_id = u.id
      ${USER_TITLE_JOIN}
      WHERE f.follower_id = ?
    `;

    const params: Array<string | null> = [user.id as string];

    if (cursor) {
      query += ` AND u.username > ?`;
      params.push(cursor);
    }

    query += ` ORDER BY u.username ASC LIMIT ?`;
    params.push(String(limit + 1));

    const results = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!results.results) {
      return c.json({ users: [], next_cursor: null, has_more: false });
    }

    const userRows = results.results.slice(0, limit);
    const hasMore = results.results.length > limit;
    const nextCursor = hasMore ? (userRows[userRows.length - 1] as { username: string }).username : null;

    const userIds = userRows.map((u: Record<string, unknown>) => u.id as string);
    const placeholders = userIds.map(() => '?').join(',');
    const [followersCounts, followingCounts] = await Promise.all([
      c.env.DB.prepare(
        `SELECT followee_id, COUNT(*) as cnt FROM follows WHERE followee_id IN (${placeholders}) GROUP BY followee_id`,
      )
        .bind(...userIds)
        .all<{ followee_id: string; cnt: number }>(),
      c.env.DB.prepare(
        `SELECT follower_id, COUNT(*) as cnt FROM follows WHERE follower_id IN (${placeholders}) GROUP BY follower_id`,
      )
        .bind(...userIds)
        .all<{ follower_id: string; cnt: number }>(),
    ]);

    const followersMap = new Map((followersCounts.results || []).map((r) => [r.followee_id, r.cnt]));
    const followingMap = new Map((followingCounts.results || []).map((r) => [r.follower_id, r.cnt]));

    const usersList = userRows.map((u: Record<string, unknown>) => ({
      ...u,
      followers_count: followersMap.get(u.id as string) || 0,
      following_count: followingMap.get(u.id as string) || 0,
      is_following: false,
    }));

    if (currentUserId) {
      const followCheck = await c.env.DB.prepare(
        `SELECT followee_id FROM follows WHERE follower_id = ? AND followee_id IN (${placeholders})`,
      )
        .bind(currentUserId, ...userIds)
        .all<{ followee_id: string }>();
      const followingSet = new Set((followCheck.results || []).map((r) => r.followee_id));
      usersList.forEach((u: Record<string, unknown>) => {
        u.is_following = followingSet.has(u.id as string);
      });
    }

    return c.json({
      users: usersList,
      next_cursor: nextCursor,
      has_more: hasMore,
    });
  } catch (error: unknown) {
    console.error('Get following error:', error);
    return c.json({ error: 'Failed to get following' }, 500);
  }
});

// PATCH /users/me - update current user profile (protected)
