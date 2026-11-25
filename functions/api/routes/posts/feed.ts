import { Hono } from 'hono';
import { stripPostColors } from '../../../../shared/post-colors.ts';
import { embedPost } from '../../../lib/crowd';
import { clampLimit } from '../../../lib/pagination';
import { EXACT_DUPLICATE_FILTER } from '../../../lib/post-visibility';
import { runInBackground } from '../../../lib/scan/index';
import { computeAuthorQuality, computeQualityScore, freshnessBoost, getTypeWeights } from '../../../lib/scoring';
import { refreshUserTrustSafe } from '../../../lib/trust';
import { enrichPostsForFeed } from '../../feed-enrichment';
import { kvCacheGet, kvCacheSet, makeCacheKey, requireAuth, resolveRequestUser } from '../../helpers';
import type { Bindings, PostRow, Variables } from '../../types';
import { colorEntitlementError, enrichFeedPosts, isOwnedMediaKey } from './helpers.ts';

export const feed = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function filterBlockedAuthors(
  db: D1Database,
  currentUserId: string | null | undefined,
  posts: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (!currentUserId || posts.length === 0) return posts;
  const postIds = posts.map((post) => String(post.id ?? '')).filter(Boolean);
  const [blockedResult, actorBlockResult, actorRows] = await Promise.all([
    db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').bind(currentUserId).all<{ blocked_id: string }>(),
    db
      .prepare('SELECT actor_url FROM ap_blocks WHERE local_user_id = ?')
      .bind(currentUserId)
      .all<{ actor_url: string }>(),
    postIds.length > 0
      ? db
          .prepare(`SELECT id, actor_id FROM posts WHERE id IN (${postIds.map(() => '?').join(',')})`)
          .bind(...postIds)
          .all<{ id: string; actor_id: string | null }>()
      : Promise.resolve({ results: [] as Array<{ id: string; actor_id: string | null }> }),
  ]);
  if (!blockedResult.success && !actorBlockResult.success) return posts;
  const blocked = new Set((blockedResult.results ?? []).map((row) => row.blocked_id));
  const blockedActors = new Set((actorBlockResult.results ?? []).map((row) => row.actor_url));
  const actorByPost = new Map((actorRows.results ?? []).map((row) => [row.id, row.actor_id]));
  return posts.filter((post) => {
    if (blocked.has(String(post.user_id))) return false;
    const actorId = actorByPost.get(String(post.id));
    return !actorId || !blockedActors.has(actorId);
  });
}

// POST /api/posts - one-step text post creation (kept for API compatibility;
// the web client uses prepare + commit for attachment support).
feed.post('/posts', requireAuth, async (c) => {
  try {
    const { text, gifKey, payloadKey } = (await c.req.json()) as {
      text?: string;
      gifKey?: string;
      payloadKey?: string;
    };
    if (typeof text !== 'string' || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 400);
    }
    const colorError = colorEntitlementError(c, text);
    if (colorError) return colorError;

    const userId = c.get('user')?.id || '';
    const username = c.get('user')?.username || 'anonymous';
    const postId = crypto.randomUUID();

    for (const key of [gifKey, payloadKey]) {
      if (key && !(await isOwnedMediaKey(c.env.DB, userId, key))) {
        return c.json({ error: 'Media key does not belong to this account' }, 422);
      }
    }
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
    const hashtags = Array.from(text.matchAll(hashtagRegex), (m) => m[1]);
    const now = new Date().toISOString();

    const result = await c.env.DB.prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, payload_key, gif_key, engagement_hotness, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 'published', ?)`,
    )
      .bind(postId, userId, username, text, JSON.stringify(hashtags), payloadKey || null, gifKey || null, now)
      .run();

    if (!result.success) {
      return c.json({ error: 'Failed to create post' }, 500);
    }
    await refreshUserTrustSafe(c.env.DB, userId, new Date(now));
    return c.json({ id: postId }, 201);
  } catch (error: unknown) {
    console.error('Post creation error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

feed.get('/posts', async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const limitRaw = c.req.query('limit');
    let limit = 20;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return c.json({ error: 'limit must be a non-negative integer' }, 400);
      }
      limit = Math.min(parsed, 50);
    }
    const hashtag = c.req.query('hashtag');
    const following = c.req.query('following') === 'true';
    const username = c.req.query('username');

    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available');
      return c.json({ error: 'Database not available' }, 500);
    }

    // Reuse the user authMiddleware already resolved; only fall back if the
    // middleware did not run for this request.
    const user = await resolveRequestUser(c, c.get('user'));
    const currentUserId: string | null = user?.id ?? null;

    // For Following tab, require authentication
    if (following && !currentUserId) {
      return c.json({ error: 'Authentication required for Following tab' }, 401);
    }

    // Chronological feeds read the current rows. A KV snapshot cannot reflect
    // publishing, edits, moderation, or deletion consistently across edges.
    let query: string;
    let params: Array<string | number> = [];

    // Helper: exclude posts from users blocked by current user
    const blockFilter = currentUserId
      ? `AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
         AND (p.actor_id IS NULL OR p.actor_id NOT IN (SELECT actor_url FROM ap_blocks WHERE local_user_id = ?))`
      : '';
    const blockParam = currentUserId ? [currentUserId, currentUserId] : [];
    const feedFilter = `${blockFilter} ${EXACT_DUPLICATE_FILTER}`;
    if (hashtag) {
      // Filter by hashtag using json_each
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) AND p.created_at < ? ${feedFilter} ORDER BY p.created_at DESC LIMIT ?`;
        params = [hashtag, cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) ${feedFilter} ORDER BY p.created_at DESC LIMIT ?`;
        params = [hashtag, ...blockParam, limit];
      }
    } else if (following && currentUserId) {
      // Following tab - show posts from followed users and current user's own posts
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
          COALESCE(p.reply_count, 0) as reply_count, 
          COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
          FROM posts p 
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
          WHERE (
            p.user_id IN (
              SELECT followee_id FROM follows WHERE follower_id = ?
            )
            OR p.user_id = ?
            OR (p.actor_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM ap_following f
              WHERE f.local_user_id = ? AND f.target_actor_url = p.actor_id AND f.status != 'rejected'
            ))
          )
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? ${feedFilter}
          ORDER BY p.created_at DESC LIMIT ?`;
        params = [currentUserId, currentUserId, currentUserId, cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
          COALESCE(p.reply_count, 0) as reply_count, 
          COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
          FROM posts p 
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
          WHERE (
            p.user_id IN (
              SELECT followee_id FROM follows WHERE follower_id = ?
            )
            OR p.user_id = ?
            OR (p.actor_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM ap_following f
              WHERE f.local_user_id = ? AND f.target_actor_url = p.actor_id AND f.status != 'rejected'
            ))
          )
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${feedFilter}
          ORDER BY p.created_at DESC LIMIT ?`;
        params = [currentUserId, currentUserId, currentUserId, ...blockParam, limit];
      }
    } else if (username) {
      // Username filter - show posts from specific user
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.username = ? AND p.hidden = 0 AND p.status = 'published' ${EXACT_DUPLICATE_FILTER} AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?`;
        params = [username, cursor, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.username = ? AND p.hidden = 0 AND p.status = 'published' ${EXACT_DUPLICATE_FILTER} ORDER BY p.created_at DESC LIMIT ?`;
        params = [username, limit];
      }
    } else {
      // Global timeline
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? ${feedFilter} ORDER BY p.created_at DESC LIMIT ?`;
        params = [cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, p.status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${feedFilter} ORDER BY p.created_at DESC LIMIT ?`;
        params = [...blockParam, limit];
      }
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!result.success) {
      console.error('Database query failed:', result);
      return c.json({ error: 'Failed to fetch posts' }, 500);
    }

    const posts = result.results || [];

    // Parallel: shared feed enrichment and vector embedding check
    await Promise.all([
      enrichPostsForFeed(posts as PostRow[], c.env.DB, currentUserId),
      // Vector embedding check for unprocessed posts
      (async () => {
        const textPosts = (posts as PostRow[]).filter((p) => p.text);
        if (textPosts.length === 0) return;
        const textPostIds = textPosts.map((p) => p.id);
        const textPlaceholders = textPostIds.map(() => '?').join(',');
        const embeddedResult = await c.env.DB.prepare(
          `SELECT post_id FROM post_embeddings WHERE post_id IN (${textPlaceholders})`,
        )
          .bind(...textPostIds)
          .all<{ post_id: string }>();
        const embeddedIds = new Set((embeddedResult.success ? embeddedResult.results : []).map((r) => r.post_id));
        for (const p of textPosts) {
          if (!embeddedIds.has(p.id)) {
            runInBackground(c, () => embedPost(c.env.DB, c.env, p.id, p.text), 'Background embed failed');
          }
        }
      })(),
    ]);

    // Chronological feeds page by `created_at` (the cursor WHERE clause uses
    // `p.created_at < ?`). Without this the client lost the cursor and stopped
    // after the first page on Following/Global.
    const nextCursor =
      posts.length >= limit ? ((posts[posts.length - 1] as { created_at?: string }).created_at ?? null) : null;

    // Return total count when filtering by hashtag
    if (hashtag) {
      const countResult = await c.env.DB.prepare(`
        SELECT COUNT(*) as count FROM posts p WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) ${EXACT_DUPLICATE_FILTER}
      `)
        .bind(hashtag)
        .first<{ count: number }>();
      return c.json({ posts, count: countResult?.count || 0, next_cursor: nextCursor });
    }

    return c.json({ posts, next_cursor: nextCursor });
  } catch (error: unknown) {
    console.error('Posts fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/posts/trending - get trending posts based on engagement and time decay
feed.get('/posts/trending', async (c) => {
  try {
    const limit = clampLimit(c.req.query('limit'), 20, 50);
    const cursor = c.req.query('cursor');
    const parts = cursor ? cursor.split(',') : [];
    const cursorScore = parts[0] || null;
    const cursorCreatedAt = parts[1] || null;
    const cursorId = parts[2] || null;
    let numericScore = cursorScore !== null ? parseFloat(cursorScore) : null;
    if (Number.isNaN(numericScore!)) numericScore = null;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Reuse the user authMiddleware already resolved.
    const user = await resolveRequestUser(c, c.get('user'));
    const currentUserId: string | null = user?.id ?? null;

    // Try cache hit (only for non-cursor requests)
    if (!cursor) {
      const cacheKey = makeCacheKey('trending', c, `${limit}`, false);
      const cached = await kvCacheGet<{ posts: Record<string, unknown>[] }>(c, cacheKey);
      if (cached) {
        // User-agnostic cache: re-apply the current user's block list.
        const posts = await filterBlockedAuthors(c.env.DB, currentUserId, cached.posts);
        await enrichFeedPosts(posts as PostRow[], c.env.DB, currentUserId);
        return c.json({ posts });
      }
    }

    // Trending algorithm:
    //   base_score = (fresh*2 + reply*3 + impression*0.1 + 1) / (hours+2)^1.5
    //   adjusted by content type weights and quality score
    const trendingFetchLimit = limit * 5;
    const query = `
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
      COALESCE(p.reply_count, 0) as reply_count,
      COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
      ((p.fresh_count * 2.0 + COALESCE(p.reply_count, 0) * 3.0 + p.impressions * 0.1 + 1.0) /
      EXP(1.5 * LN((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0))) as score
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
      WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER} AND p.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
      ORDER BY score DESC, p.created_at DESC
      LIMIT ?
    `;
    const params: Array<unknown> = [trendingFetchLimit];

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();
    const rawPosts = (result.results || []) as Record<string, unknown>[];

    // Compute author quality scores per user
    const authorQualityMap = new Map<string, number>();
    const userIds = [...new Set(rawPosts.map((p) => p.user_id as string))].filter(Boolean);
    if (userIds.length > 0) {
      const authorRows = await c.env.DB.prepare(
        `SELECT u.id, u.display_name, u.bio, u.avatar_key, u.badge_type, u.name_color, u.created_at,
          COALESCE(SUM(p.fresh_count), 0) as total_fresh,
          COALESCE(SUM(p.reply_count), 0) as total_reply,
          COALESCE(SUM(p.impressions), 0) as total_impressions,
          COUNT(p.id) as post_count
         FROM users u
         LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'published'
         WHERE u.id IN (${userIds.map(() => '?').join(',')})
         GROUP BY u.id`,
      )
        .bind(...userIds)
        .all<{
          id: string;
          display_name: string | null;
          bio: string | null;
          avatar_key: string | null;
          created_at: string;
          total_fresh: number;
          total_reply: number;
          total_impressions: number;
          post_count: number;
        }>();
      for (const row of authorRows.results || []) {
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        const accountAgeDays = ageMs / 86400000;
        const postCount = row.post_count || 1;
        const authorQuality = computeAuthorQuality({
          freshRatio: (row.total_fresh || 0) / postCount / 5,
          replyRate: (row.total_reply || 0) / Math.max(row.total_impressions || postCount, 1),
          accountAgeDays: Math.max(accountAgeDays, 1),
          hasDisplayName: !!row.display_name,
          hasBio: !!row.bio,
          hasAvatar: !!row.avatar_key,
        });
        // Map from 0-1 range to 0.5-1.5 multiplier range
        authorQualityMap.set(row.id, 0.5 + authorQuality);
      }
    }

    // Compute adjusted score with quality, type weights, and author quality
    const scored = rawPosts.map((p) => {
      const qualityScore = computeQualityScore(
        stripPostColors(String(p.text || '')),
        !!(p.payload_key || p.swf_key),
        0,
      );
      const typeFactor = (() => {
        const w = getTypeWeights(p.payload_key as string | null, p.swf_key as string | null);
        return (w.fresh + w.reply + w.impression) / 4.5;
      })();
      const authorQuality = authorQualityMap.get(p.user_id as string) || 1.0;
      const rawScore = Number(p.score) || 0;
      const fresh = freshnessBoost(p.created_at as string);
      return { post: p, score: rawScore * qualityScore * typeFactor * authorQuality * fresh };
    });

    // Cursor filtering and sorting
    let filtered = scored;
    if (numericScore !== null && cursorCreatedAt) {
      filtered = scored.filter((s) => {
        const ca = String(s.post.created_at || '');
        const id = String(s.post.id || '');
        return (
          s.score < numericScore! ||
          (s.score === numericScore && ca < cursorCreatedAt!) ||
          (s.score === numericScore && ca === cursorCreatedAt && id < cursorId!)
        );
      });
    }

    filtered.sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      const ca = String(b.post.created_at || '').localeCompare(String(a.post.created_at || ''));
      if (ca !== 0) return ca;
      return String(b.post.id || '').localeCompare(String(a.post.id || ''));
    });

    const page = filtered.slice(0, limit);

    // Build enriched posts (unfiltered, so the shared cache stays block-free)
    const posts = page.map((s) => {
      const p = s.post;
      p.score = s.score;
      return p;
    });

    // Re-apply the current user's block list for the response only.
    const visiblePosts = await filterBlockedAuthors(c.env.DB, currentUserId, posts);

    await enrichFeedPosts(visiblePosts as PostRow[], c.env.DB, currentUserId);

    // Write to cache (non-cursor only)
    if (!cursor && c.env.CACHE) {
      const cacheKey = makeCacheKey('trending', c, `${limit}`, false);
      const cacheData = {
        posts: posts.map((p: Record<string, unknown>) => ({ ...p, is_freshed: false, is_bookmarked: false })),
        next_cursor:
          posts.length > 0
            ? `${(posts[posts.length - 1] as Record<string, unknown>).score},${(posts[posts.length - 1] as Record<string, unknown>).created_at},${(posts[posts.length - 1] as Record<string, unknown>).id}`
            : null,
      };
      await kvCacheSet(c, cacheKey, cacheData, 60);
    }

    const nextCursor =
      visiblePosts.length > 0
        ? `${(visiblePosts[visiblePosts.length - 1] as Record<string, unknown>).score},${(visiblePosts[visiblePosts.length - 1] as Record<string, unknown>).created_at},${(visiblePosts[visiblePosts.length - 1] as Record<string, unknown>).id}`
        : null;

    return c.json({ posts: visiblePosts, next_cursor: nextCursor });
  } catch (error: unknown) {
    console.error('Trending posts error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});
