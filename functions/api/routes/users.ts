import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { isValidB64, isValidVaultKdfParams, isValidWrappedKey } from '../../../src/lib/vault/primitives';
import { deleteAccount } from '../../lib/account-deletion';
import { enrichPostsWithAttachments } from '../../lib/attachments';
import { deleteSession, getMeWithSession, getSessionToken, verifySrpPassword } from '../../lib/auth';
import { isSupportedSrpKdf } from '../../lib/srp';
import { detectMimeType, isAllowedImageMime, requireAuth } from '../helpers';
import type { Bindings, PostRow, SrpProofBody, Variables } from '../types';

const users = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const RECOMMENDED_SELECT = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
  COALESCE(p.reply_count, 0) as reply_count, 
  COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at`;

async function enrichPostsWithReactions(
  posts: PostRow[],
  db: D1Database,
  currentUserId?: string | null,
): Promise<void> {
  if (posts.length === 0) return;

  const postIds = posts.map((p) => p.id);
  const placeholders = postIds.map(() => '?').join(',');

  const summaryResult = await db
    .prepare(
      `SELECT post_id, emoji, COUNT(*) AS count FROM reactions
       WHERE post_id IN (${placeholders})
       GROUP BY post_id, emoji`,
    )
    .bind(...postIds)
    .all<{ post_id: string; emoji: string; count: number }>();

  const mine = new Set<string>();
  if (currentUserId) {
    const mineResult = await db
      .prepare(`SELECT post_id, emoji FROM reactions WHERE user_id = ? AND post_id IN (${placeholders})`)
      .bind(currentUserId, ...postIds)
      .all<{ post_id: string; emoji: string }>();
    for (const r of mineResult.results || []) {
      mine.add(`${r.post_id}:${r.emoji}`);
    }
  }

  const stampNames = new Set<string>();
  for (const row of summaryResult.results || []) {
    if (/^:.+:$/.test(row.emoji)) {
      stampNames.add(row.emoji);
    }
  }

  const stampUrlMap = new Map<string, string>();
  if (stampNames.size > 0) {
    const stampRows = await db
      .prepare(
        `SELECT name, image_key FROM custom_stamps WHERE name IN (${Array.from(stampNames)
          .map(() => '?')
          .join(',')})`,
      )
      .bind(...stampNames)
      .all<{ name: string; image_key: string }>();
    for (const s of stampRows.results || []) {
      stampUrlMap.set(s.name, `/api/images/${s.image_key}`);
    }
  }

  const grouped = new Map<string, Array<{ emoji: string; count: number; reacted: boolean; stamp_url?: string }>>();
  for (const row of summaryResult.results || []) {
    if (!grouped.has(row.post_id)) grouped.set(row.post_id, []);
    const entry: { emoji: string; count: number; reacted: boolean; stamp_url?: string } = {
      emoji: row.emoji,
      count: row.count,
      reacted: mine.has(`${row.post_id}:${row.emoji}`),
    };
    const stampUrl = stampUrlMap.get(row.emoji);
    if (stampUrl) entry.stamp_url = stampUrl;
    grouped.get(row.post_id)!.push(entry);
  }

  for (const post of posts) {
    post.reactions = grouped.get(post.id) || [];
  }
}

// GET /users/suggestions - get user suggestions for "who to follow"
users.get('/users/suggestions', async (c) => {
  try {
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;

    if (!sessionData || !c.env.DB) {
      return c.json({ users: [] });
    }

    const currentUserId = sessionData.user.id;

    const pool = await c.env.DB.prepare(`
      SELECT id, username, display_name, avatar_key, badge_type
      FROM users
      WHERE id != ?
      AND id NOT IN (
        SELECT followee_id FROM follows WHERE follower_id = ?
      )
      ORDER BY id
      LIMIT 100
    `)
      .bind(currentUserId, currentUserId)
      .all();

    const poolArr = pool.results || [];
    const suggestions =
      poolArr.length <= 3
        ? poolArr
        : (() => {
            const shuffled = [...poolArr];
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            return shuffled.slice(0, 3);
          })();

    return c.json({ users: suggestions });
  } catch (error: unknown) {
    console.error('User suggestions error:', error);
    return c.json({ users: [] });
  }
});

// POST /follows/:id - follow a user by ID (protected)
users.post('/follows/:id', requireAuth, async (c) => {
  try {
    const followeeId = c.req.param('id');

    if (!followeeId) {
      return c.json({ error: 'User ID required' }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const followerId = user.id;

    if (followerId === followeeId) {
      return c.json({ error: 'Cannot follow yourself' }, 400);
    }

    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(followeeId).first();

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    await c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)')
      .bind(followerId, followeeId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Follow error:', error);
    return c.json({ error: 'Failed to follow user' }, 500);
  }
});

// POST /remote-follow - follow a remote ActivityPub user (protected)
users.post('/remote-follow', requireAuth, async (c) => {
  try {
    const { target } = (await c.req.json()) as { target?: string };
    if (!target || !target.includes('@')) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400);
    }

    const [remoteUsername, domain] = target.split('@');
    if (!remoteUsername || !domain) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const localUser = user;

    const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${remoteUsername}@${domain}`;
    const wfResponse = await fetch(webfingerUrl, {
      headers: { Accept: 'application/jrd+json, application/json' },
    });

    if (!wfResponse.ok) {
      return c.json({ error: 'Could not resolve remote user' }, 404);
    }

    const wfData = (await wfResponse.json()) as { links?: Array<{ rel: string; href?: string; type?: string }> };
    const selfLink = wfData.links?.find((l: { rel: string }) => l.rel === 'self');
    if (!selfLink?.href) {
      return c.json({ error: 'Remote user has no ActivityPub actor link' }, 400);
    }

    const actorUrl = selfLink.href;

    const actorResponse = await fetch(actorUrl, {
      headers: { Accept: 'application/activity+json, application/ld+json' },
    });

    if (!actorResponse.ok) {
      return c.json({ error: 'Could not fetch remote actor' }, 404);
    }

    const actorData = (await actorResponse.json()) as { inbox?: string };
    const inboxUrl = actorData.inbox;
    if (!inboxUrl) {
      return c.json({ error: 'Remote actor has no inbox' }, 400);
    }

    const existing = await c.env.DB.prepare(
      'SELECT id FROM ap_following WHERE local_user_id = ? AND target_actor_url = ?',
    )
      .bind(localUser.id, actorUrl)
      .first();

    if (existing) {
      return c.json({ error: 'Already following this user' }, 409);
    }

    const followId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, target_username, target_domain, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `)
      .bind(followId, localUser.id, actorUrl, inboxUrl, remoteUsername, domain)
      .run();

    const followActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${c.env.BASE_URL}/activities/follow-${followId}`,
      type: 'Follow',
      actor: `${c.env.BASE_URL}/actors/${localUser.username}`,
      object: actorUrl,
      to: [actorUrl],
    };

    if (c.env.AP_DELIVERY_QUEUE) {
      await c.env.AP_DELIVERY_QUEUE.send({
        type: 'delivery',
        inboxUrl,
        activity: followActivity,
        senderUsername: localUser.username,
      });
    }

    await c.env.DB.prepare('UPDATE ap_following SET status = ? WHERE id = ?').bind('sent', followId).run();

    return c.json({
      following: true,
      target: target,
      status: 'pending',
      message: 'Follow request sent to remote user',
    });
  } catch (error: unknown) {
    console.error('Remote follow error:', error);
    return c.json({ error: 'Failed to follow remote user' }, 500);
  }
});

// DELETE /remote-follow - unfollow a remote ActivityPub user (protected)
users.delete('/remote-follow', requireAuth, async (c) => {
  try {
    const { target } = (await c.req.json()) as { target?: string };
    if (!target || !target.includes('@')) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400);
    }

    const [remoteUsername, domain] = target.split('@');
    if (!remoteUsername || !domain) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const localUser = user;

    const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${remoteUsername}@${domain}`;
    const wfResponse = await fetch(webfingerUrl, {
      headers: { Accept: 'application/jrd+json, application/json' },
    });

    if (!wfResponse.ok) {
      return c.json({ error: 'Could not resolve remote user' }, 404);
    }

    const wfData = (await wfResponse.json()) as { links?: Array<{ rel: string; href?: string; type?: string }> };
    const selfLink = wfData.links?.find((l: { rel: string }) => l.rel === 'self');
    if (!selfLink?.href) {
      return c.json({ error: 'Remote user has no ActivityPub actor link' }, 400);
    }

    const actorUrl = selfLink.href;

    const following = (await c.env.DB.prepare(
      'SELECT id, target_inbox_url FROM ap_following WHERE local_user_id = ? AND target_actor_url = ?',
    )
      .bind(localUser.id, actorUrl)
      .first()) as { id: string; target_inbox_url: string } | null;

    if (!following) {
      return c.json({ error: 'Not following this user' }, 404);
    }

    await c.env.DB.prepare('DELETE FROM ap_following WHERE id = ?').bind(following.id).run();

    const followActivityId = `${c.env.BASE_URL}/activities/follow-${following.id}`;
    const undoActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${c.env.BASE_URL}/activities/undo-${following.id}`,
      type: 'Undo',
      actor: `${c.env.BASE_URL}/actors/${localUser.username}`,
      object: {
        id: followActivityId,
        type: 'Follow',
        actor: `${c.env.BASE_URL}/actors/${localUser.username}`,
        object: actorUrl,
      },
      to: [actorUrl],
    };

    if (c.env.AP_DELIVERY_QUEUE && following.target_inbox_url) {
      await c.env.AP_DELIVERY_QUEUE.send({
        type: 'delivery',
        inboxUrl: following.target_inbox_url,
        activity: undoActivity,
        senderUsername: localUser.username,
      });
    }

    return c.json({
      following: false,
      target: target,
      message: 'Unfollow request sent to remote user',
    });
  } catch (error: unknown) {
    console.error('Remote unfollow error:', error);
    return c.json({ error: 'Failed to unfollow remote user' }, 500);
  }
});

// GET /users/suggest?q=prefix - suggest usernames matching prefix
users.get('/users/suggest', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q || q.length < 1) {
      return c.json({ users: [] });
    }

    const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 20);
    const prefix = q.toLowerCase();

    const result = await c.env.DB.prepare(`
      SELECT id, username, display_name, avatar_key, badge_type
      FROM users
      WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
      ORDER BY
        CASE WHEN LOWER(username) LIKE ? THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT ?
    `)
      .bind(prefix + '%', prefix + '%', prefix + '%', limit)
      .all();

    const usersList = (result.results || []).map((u: Record<string, unknown>) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name || '',
      avatar_key: u.avatar_key || '',
      badge_type: (u.badge_type as string | null) ?? null,
    }));

    return c.json({ users: usersList }, 200, {
      'Cache-Control': 'public, max-age=15',
    });
  } catch (error: unknown) {
    console.error('User suggest error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /users/:username - get public user profile
users.get('/users/:username', async (c) => {
  try {
    const username = c.req.param('username');

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, badge_type, header_key, created_at, pinned_post_id 
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
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
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
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
users.get('/users/:username/pinned', async (c) => {
  try {
    const username = c.req.param('username');
    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = await c.env.DB.prepare('SELECT id, pinned_post_id FROM users WHERE username = ? COLLATE NOCASE')
      .bind(username)
      .first<{ id: string; pinned_post_id: string | null }>();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (!user.pinned_post_id) {
      return c.json({ post: null });
    }

    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    const currentUserId = sessionData?.user.id ?? null;

    const row = await c.env.DB.prepare(
      `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0`,
    )
      .bind(user.pinned_post_id)
      .first();

    if (!row) {
      return c.json({ post: null });
    }

    const posts = [row as unknown as PostRow];
    await enrichPostsWithReactions(posts, c.env.DB, currentUserId);
    await enrichPostsWithAttachments(posts, c.env.DB);

    return c.json({ post: posts[0] });
  } catch (error: unknown) {
    console.error('Get pinned post error:', error);
    return c.json({ error: 'Failed to get pinned post' }, 500);
  }
});

// POST /profile/pin - pin a post to the current user's profile (protected)
users.post('/profile/pin', requireAuth, async (c) => {
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
users.delete('/profile/pin', requireAuth, async (c) => {
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
users.get('/users/:username/followers', async (c) => {
  try {
    const username = c.req.param('username');
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, badge_type, created_at 
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    let currentUserId: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    if (sessionData) {
      currentUserId = sessionData.user.id;
    }

    let query = `
      SELECT 
        u.id, u.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language,
        u.created_at
      FROM follows f
      JOIN users u ON f.follower_id = u.id
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
users.get('/users/:username/following', async (c) => {
  try {
    const username = c.req.param('username');
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, badge_type, created_at 
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    let currentUserId: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    if (sessionData) {
      currentUserId = sessionData.user.id;
    }

    let query = `
      SELECT 
        u.id, u.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language,
        u.created_at
      FROM follows f
      JOIN users u ON f.followee_id = u.id
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
users.patch('/users/me', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const userId = user.id;
    let display_name: string | undefined;
    let bio: string | undefined;
    let language: string | undefined;
    let ng_words: string[] | undefined;
    let avatarFile: File | undefined;
    let headerFile: File | undefined;
    let removeHeader = false;

    const contentType = c.req.header('content-type');

    if (contentType?.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      display_name = (formData.get('display_name') as string | null) || undefined;
      bio = (formData.get('bio') as string | null) || undefined;
      avatarFile = (formData.get('avatar') as File | null) || undefined;
      headerFile = (formData.get('header') as File | null) || undefined;
      removeHeader = formData.get('remove_header') === '1' || formData.get('remove_header') === 'true';

      if (avatarFile && avatarFile.size > 0) {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(avatarFile.type)) {
          return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' }, 400);
        }

        if (avatarFile.size > 5 * 1024 * 1024) {
          return c.json({ error: 'Avatar must be ≤5MB' }, 413);
        }

        if (!c.env.BUCKET) {
          return c.json({ error: 'Storage not available' }, 500);
        }

        const fileBuffer = await avatarFile.arrayBuffer();

        const detected = detectMimeType(fileBuffer);
        if (!isAllowedImageMime(detected)) {
          return c.json({ error: 'File content does not match allowed image types' }, 400);
        }
        const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

        const existingKey = `avatar/${hashHex}`;
        const existingObject = await c.env.BUCKET.head(existingKey);

        let avatarKey: string;
        if (existingObject) {
          avatarKey = existingKey;
          console.log('Reusing existing avatar file:', avatarKey);
        } else {
          avatarKey = existingKey;
          await c.env.BUCKET.put(avatarKey, fileBuffer, {
            httpMetadata: {
              contentType: avatarFile.type,
            },
          });
          console.log('Uploaded new avatar file:', avatarKey);
        }

        await c.env.DB.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').bind(avatarKey, userId).run();
      }

      if (headerFile && headerFile.size > 0) {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(headerFile.type)) {
          return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' }, 400);
        }

        const maxHeaderSize = 5 * 1024 * 1024;
        if (headerFile.size > maxHeaderSize) {
          return c.json({ error: 'Header image must be ≤5MB' }, 413);
        }

        if (!c.env.BUCKET) {
          return c.json({ error: 'Storage not available' }, 500);
        }

        const fileBuffer = await headerFile.arrayBuffer();
        const detected = detectMimeType(fileBuffer);
        if (!isAllowedImageMime(detected)) {
          return c.json({ error: 'File content does not match allowed image types' }, 400);
        }
        const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

        const existingKey = `header/${hashHex}`;
        const existingObject = await c.env.BUCKET.head(existingKey);

        let headerKey: string;
        if (existingObject) {
          headerKey = existingKey;
          console.log('Reusing existing header file:', headerKey);
        } else {
          headerKey = existingKey;
          await c.env.BUCKET.put(headerKey, fileBuffer, {
            httpMetadata: {
              contentType: headerFile.type,
            },
          });
          console.log('Uploaded new header file:', headerKey);
        }

        await c.env.DB.prepare('UPDATE users SET header_key = ? WHERE id = ?').bind(headerKey, userId).run();
      } else if (removeHeader) {
        await c.env.DB.prepare('UPDATE users SET header_key = NULL WHERE id = ?').bind(userId).run();
      }
    } else {
      const body = await c.req.json();
      display_name = body.display_name;
      bio = body.bio;
      language = body.language;
      ng_words = body.ng_words;
    }

    if (display_name !== undefined && display_name.length > 50) {
      return c.json({ error: 'Display name must be ≤50 characters' }, 400);
    }

    if (bio !== undefined && bio.length > 200) {
      return c.json({ error: 'Bio must be ≤200 characters' }, 400);
    }

    if (language !== undefined && !['en', 'ja'].includes(language)) {
      return c.json({ error: 'Language must be either "en" or "ja"' }, 400);
    }

    if (ng_words !== undefined) {
      if (!Array.isArray(ng_words)) {
        return c.json({ error: 'ng_words must be an array' }, 400);
      }
      if (ng_words.length > 100) {
        return c.json({ error: 'Maximum 100 NG words allowed' }, 400);
      }
      for (const word of ng_words) {
        if (typeof word !== 'string') {
          return c.json({ error: 'All NG words must be strings' }, 400);
        }
        if (word.length > 50) {
          return c.json({ error: 'Each NG word must be ≤50 characters' }, 400);
        }
      }
    }

    const updates: string[] = [];
    const values: (string | null)[] = [];

    if (display_name !== undefined) {
      updates.push('display_name = ?');
      values.push(display_name);
    }

    if (bio !== undefined) {
      updates.push('bio = ?');
      values.push(bio);
    }

    if (language !== undefined) {
      updates.push('language = ?');
      values.push(language);
    }

    if (ng_words !== undefined) {
      updates.push('ng_words = ?');
      values.push(JSON.stringify(ng_words));
    }

    if (updates.length > 0) {
      values.push(userId);

      const result = await c.env.DB.prepare(`
        UPDATE users SET ${updates.join(', ')} WHERE id = ?
      `)
        .bind(...values)
        .run();

      if (!result.success) {
        return c.json({ error: 'Failed to update profile' }, 500);
      }
    }

    type UpdatedUserRow = {
      id: string;
      email: string;
      username: string;
      display_name: string | null;
      bio: string | null;
      avatar_key: string | null;
      badge_type: string | null;
      header_key: string | null;
      language: string | null;
      ng_words: string | null;
      created_at: string;
    };

    const updatedUser = await c.env.DB.prepare(`
      SELECT id, email, username, display_name, bio, avatar_key, badge_type, header_key, language, ng_words, created_at 
      FROM users 
      WHERE id = ?
    `)
      .bind(userId)
      .first<UpdatedUserRow>();

    return c.json({
      user: {
        ...updatedUser,
        ng_words: JSON.parse(updatedUser?.ng_words ?? '[]') as string[],
      },
    });
  } catch (error: unknown) {
    console.error('Update profile error:', error);
    return c.json({ error: 'Failed to update profile' }, 500);
  }
});

// PATCH /users/me/email - update email (protected)
//
// Re-authentication is an SRP proof of the current password
// (`current_srp = {challenge_id, A, M1}` from /api/auth/reauth/start), so the
// password itself never reaches the server. This also fixes SRP-only accounts,
// which previously could not change email at all: they have no `password_hash`
// for the old plaintext path to compare against.
users.patch('/users/me/email', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const { current_srp, new_email } = await c.req.json();

    if (!new_email) {
      return c.json({ error: 'New email is required' }, 400);
    }

    const proof = current_srp as SrpProofBody | undefined;
    if (!proof?.challenge_id || !proof.A || !proof.M1) {
      return c.json({ error: 'Current password proof is required' }, 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(new_email)) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    const userId = user.id;

    const isValid = await verifySrpPassword(c.env, userId, proof.challenge_id, proof.A, proof.M1);
    if (!isValid) {
      return c.json({ error: 'Current password is incorrect' }, 401);
    }

    const existingEmail = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .bind(new_email, userId)
      .first();
    if (existingEmail) {
      return c.json({ error: 'Email is already taken' }, 409);
    }

    const result = await c.env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(new_email, userId).run();

    if (!result.success) {
      return c.json({ error: 'Failed to update email' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Update email error:', error);
    return c.json({ error: 'Failed to update email' }, 500);
  }
});

// PATCH /users/me/password - update password (protected)
//
// Neither the current nor the new password is ever sent: the current one is
// proven via SRP, the new one arrives only as a verifier the client derived
// locally. `password_hash` is blanked unconditionally so the account stops
// carrying a value that a database dump could dictionary-attack outside the
// protocol.
users.patch('/users/me/password', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const { srp_salt, srp_verifier, srp_group, srp_kdf, current_srp, vault_kek } = await c.req.json();

    if (!srp_salt || !srp_verifier || !srp_group || !srp_kdf) {
      return c.json({ error: 'New SRP verifier required' }, 400);
    }
    if (srp_group !== '2048') return c.json({ error: 'Unsupported SRP group' }, 400);
    if (!isSupportedSrpKdf(srp_kdf)) return c.json({ error: 'Unsupported SRP KDF' }, 400);

    const proof = current_srp as SrpProofBody | undefined;
    if (!proof?.challenge_id || !proof.A || !proof.M1) {
      return c.json({ error: 'Current password proof is required' }, 400);
    }

    const userId = user.id;

    const verified = await verifySrpPassword(c.env, userId, proof.challenge_id, proof.A, proof.M1);
    if (!verified) {
      return c.json({ error: 'Current password is incorrect' }, 401);
    }

    // A vault exists ⇒ VK is wrapped under a KEK derived from the OLD password.
    // The client holds that password right now, so it must re-wrap VK in the
    // same request; otherwise the vault is orphaned the moment this lands.
    const vaultRow = (await c.env.DB.prepare('SELECT user_id FROM vault_keys WHERE user_id = ?')
      .bind(userId)
      .first()) as { user_id: string } | null;
    const vaultUpdate = await (async () => {
      if (!vaultRow) {
        if (vault_kek !== undefined) return { error: 'No vault is enabled' } as const;
        return null;
      }
      const rewrap = vault_kek as { salt?: unknown; kdf_params?: unknown; wrapped_vk?: unknown } | undefined;
      if (!rewrap) return { error: 'vault_rewrap_required' } as const;
      if (!isValidB64(rewrap.salt, 16)) return { error: 'Invalid vault salt' } as const;
      if (!isValidVaultKdfParams(rewrap.kdf_params)) return { error: 'Unsupported vault KDF parameters' } as const;
      if (!isValidWrappedKey(rewrap.wrapped_vk)) return { error: 'Invalid wrapped vault key' } as const;
      return {
        sql: `UPDATE vault_keys SET salt = ?, kdf_params = ?, wrapped_vk = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE user_id = ?`,
        binds: [rewrap.salt as string, JSON.stringify(rewrap.kdf_params), rewrap.wrapped_vk as string, userId],
      } as const;
    })();
    if (vaultUpdate && 'error' in vaultUpdate) {
      const status = vaultUpdate.error === 'vault_rewrap_required' ? 409 : 400;
      return c.json({ error: vaultUpdate.error }, status);
    }

    // password_hash is blanked unconditionally: the account must stop carrying
    // a value a dump could dictionary-attack outside the SRP protocol.
    const statements = [
      c.env.DB.prepare(
        `UPDATE users SET password_hash = '', srp_salt = ?, srp_verifier = ?, srp_group = ?, srp_kdf = ? WHERE id = ?`,
      ).bind(srp_salt, srp_verifier, srp_group, srp_kdf, userId),
    ];
    if (vaultUpdate) {
      statements.push(c.env.DB.prepare(vaultUpdate.sql).bind(...vaultUpdate.binds));
    }
    // batch() is atomic: the vault must never end up pointing at a KEK the new
    // password cannot derive, or vice versa.
    const results = await c.env.DB.batch(statements);
    if (results.some((r) => !r.success)) {
      return c.json({ error: 'Failed to update password' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Update password error:', error);
    return c.json({ error: 'Failed to update password' }, 500);
  }
});

// DELETE /users/me - delete current user account (protected)
users.delete('/users/me', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const userId = user.id;

    await deleteAccount(c.env, userId);

    const token = getSessionToken(c.req.raw);
    if (token) {
      await deleteSession(c.env, token);
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Delete account error:', error);
    return c.json({ error: 'Failed to delete account', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /users/me/avatar - upload avatar (protected)
users.post('/users/me/avatar', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const contentType = c.req.header('content-type');
    const contentLength = c.req.header('content-length');

    if (!contentType || !contentLength) {
      return c.json({ error: 'Content-Type and Content-Length headers required' }, 400);
    }

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!contentType || !allowedTypes.includes(contentType as string)) {
      return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' }, 400);
    }

    const maxSize = 5 * 1024 * 1024;
    if (Number(contentLength) > maxSize) {
      return c.json({ error: 'Avatar must be ≤5MB' }, 413);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const userId = user.id;

    const fileData = await c.req.arrayBuffer();

    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'Avatar must be ≤5MB' }, 413);
    }

    const detected = detectMimeType(fileData);
    if (!isAllowedImageMime(detected)) {
      return c.json({ error: 'File content does not match allowed image types' }, 400);
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', fileData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const existingKey = `avatar/${hashHex}`;
    const existingObject = await c.env.BUCKET.head(existingKey);

    let avatarKey: string;
    if (existingObject) {
      avatarKey = existingKey;
      console.log('Reusing existing avatar file:', avatarKey);
    } else {
      avatarKey = existingKey;
      await c.env.BUCKET.put(avatarKey, fileData, {
        httpMetadata: {
          contentType: contentType,
        },
      });
      console.log('Uploaded new avatar file:', avatarKey);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').bind(avatarKey, userId).run();

    if (!result.success) {
      return c.json({ error: 'Failed to update avatar' }, 500);
    }

    return c.json({ success: true, avatar_key: avatarKey });
  } catch (error: unknown) {
    console.error('Avatar upload error:', error);
    return c.json({ error: 'Avatar upload failed' }, 500);
  }
});

// POST /users/:username/follow - follow a user (protected)
users.post('/users/:username/follow', requireAuth, async (c) => {
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
users.delete('/users/:username/follow', requireAuth, async (c) => {
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
users.post('/users/:username/block', requireAuth, async (c) => {
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
users.delete('/users/:username/block', requireAuth, async (c) => {
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
users.get('/users/me/blocked', requireAuth, async (c) => {
  try {
    const userId = c.get('user')!.id;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_key, u.badge_type
       FROM blocks b
       JOIN users u ON u.id = b.blocked_id
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

export default users;
