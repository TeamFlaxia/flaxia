import type { Context } from 'hono';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { isAdmin } from '../../../src/lib/admin';
import { copyHtmlToWvfs, extractFileFromZip, extractZipToR2 } from '../../../src/lib/wvfs-zip-server';
import type { ReportCategory } from '../../../src/types/post';
import { buildCreateActivity, buildDeleteActivity, buildNoteObject } from '../../lib/activitypub/note';
import {
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentRecord,
  buildAttachmentKey,
  collectAttachmentKeys,
  deleteAttachmentRows,
  enrichPostsWithAttachments,
  imageAttachmentKeys,
  kindFromUpload,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_PLUS,
  parseAttachmentKey,
  sequenceAttachments,
  sumAttachmentSizes,
  validateAttachmentInputs,
} from '../../lib/attachments';
import { getMeWithSession, getSessionToken } from '../../lib/auth';
import { getUserPlan } from '../../lib/billing';
import { embedPost, isImageKey, screenPostImages } from '../../lib/crowd';
import { validateImageDimensions } from '../../lib/image-dimensions';
import { sendPushToAll } from '../../lib/notify';
import { computeAuthorQuality, computeQualityScore, freshnessBoost, getTypeWeights } from '../../lib/scoring';
import { batchGetFreshAndBookmarkStatus, kvCacheGet, kvCacheSet, makeCacheKey, requireAuth } from '../helpers';
import type { ActorData, Bindings, PollOptionRow, PollRow, PostRow, Variables } from '../types';
import {
  applyBanditRewards,
  cosineSimilarity,
  getProjection,
  loadBanditConfig,
  loadBanditPrior,
  loadBanditState,
  loadDwellStats,
  loadOrComputeInterestVector,
  saveBanditState,
} from './recommender';

const posts = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Per-post attachment ceiling for a user: Flaxia+ subscribers get the larger
 * cap, everyone else the free limit.
 */
async function resolveAttachmentLimit(env: Bindings, userId: string): Promise<number> {
  if (!userId) return MAX_ATTACHMENTS;
  const plan = await getUserPlan(env, userId);
  return plan.isActive ? MAX_ATTACHMENTS_PLUS : MAX_ATTACHMENTS;
}

async function ensureReactionsTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS reactions (
           post_id    TEXT NOT NULL,
           user_id    TEXT NOT NULL,
           emoji      TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           PRIMARY KEY (post_id, user_id, emoji)
         )`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id)').run();
  } catch (e) {
    console.error('Failed to ensure reactions table:', e);
  }
}

async function filterBlockedAuthors(
  db: D1Database,
  currentUserId: string | null | undefined,
  posts: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (!currentUserId || posts.length === 0) return posts;
  const blockedResult = await db
    .prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?')
    .bind(currentUserId)
    .all<{ blocked_id: string }>();
  if (!blockedResult.success || blockedResult.results.length === 0) return posts;
  const blocked = new Set(blockedResult.results.map((r) => r.blocked_id));
  return posts.filter((p) => !blocked.has(String(p.user_id)));
}
// POST /api/posts - one-step text post creation (kept for API compatibility;
// the web client uses prepare + commit for attachment support).
posts.post('/posts', requireAuth, async (c) => {
  try {
    const { text, gifKey, payloadKey } = (await c.req.json()) as {
      text?: string;
      gifKey?: string;
      payloadKey?: string;
    };
    if (typeof text !== 'string' || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 400);
    }

    const userId = c.get('user')?.id || '';
    const username = c.get('user')?.username || 'anonymous';
    const postId = crypto.randomUUID();
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
    return c.json({ id: postId }, 201);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Post creation error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

posts.get('/posts', async (c) => {
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

    // Get current user ID for fresh status (optional for all tabs, required for Following tab)
    let currentUserId: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    if (sessionData) {
      currentUserId = sessionData.user.id;
    }

    // For Following tab, require authentication
    if (following && !currentUserId) {
      return c.json({ error: 'Authentication required for Following tab' }, 401);
    }

    // Try cache hit (first page only)
    if (!cursor) {
      const cacheKey = makeCacheKey(
        'timeline',
        c,
        `${limit}:${hashtag || ''}:${following ? 'following' : ''}:${username || ''}`,
        !following,
      );
      const cached = await kvCacheGet<{ posts: Record<string, unknown>[] }>(c, cacheKey);
      if (cached) {
        // User-agnostic cache: shared feeds must re-apply the current user's block list.
        let posts = cached.posts;
        if (!following && !username) {
          posts = (await filterBlockedAuthors(c.env.DB, currentUserId, posts)).slice(0, limit);
        }
        if (currentUserId && posts.length > 0) {
          const postIds = posts.map((p) => String(p.id));
          const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
          posts.forEach((post: Record<string, unknown>) => {
            post.is_freshed = freshed.has(post.id as string);
            post.is_bookmarked = bookmarked.has(post.id as string);
          });
        }
        await enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId);
        await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
        await enrichPostsWithAttachments(posts as PostRow[], c.env.DB);
        await enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId);
        return c.json({ posts });
      }
    }

    let query: string;
    let params: Array<string | number> = [];

    // Helper: exclude posts from users blocked by current user
    const blockFilter = currentUserId
      ? 'AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)'
      : '';
    const blockParam = currentUserId ? [currentUserId] : [];
    // Shared first pages fetch a small surplus so the user-agnostic cache can
    // still return a full page after the per-user block filter runs in JS.
    const fetchLimit = limit + 20;

    if (hashtag) {
      // Filter by hashtag using json_each
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) AND p.created_at < ? ${blockFilter} ORDER BY p.created_at DESC LIMIT ?`;
        params = [hashtag, cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) ORDER BY p.created_at DESC LIMIT ?`;
        params = [hashtag, fetchLimit];
      }
    } else if (following && currentUserId) {
      // Following tab - show posts from followed users and current user's own posts
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
          COALESCE(p.reply_count, 0) as reply_count, 
          COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
          FROM posts p 
          LEFT JOIN users u ON p.user_id = u.id 
          WHERE (
            p.user_id IN (
              SELECT followee_id FROM follows WHERE follower_id = ?
            )
            OR p.user_id = ?
          )
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? ${blockFilter}
          ORDER BY p.created_at DESC LIMIT ?`;
        params = [currentUserId, currentUserId, cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
          COALESCE(p.reply_count, 0) as reply_count, 
          COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
          FROM posts p 
          LEFT JOIN users u ON p.user_id = u.id 
          WHERE (
            p.user_id IN (
              SELECT followee_id FROM follows WHERE follower_id = ?
            )
            OR p.user_id = ?
          )
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${blockFilter}
          ORDER BY p.created_at DESC LIMIT ?`;
        params = [currentUserId, currentUserId, ...blockParam, limit];
      }
    } else if (username) {
      // Username filter - show posts from specific user
      if (cursor) {
        query =
          "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.username = ? AND p.hidden = 0 AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?";
        params = [username, cursor, limit];
      } else {
        query =
          "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.username = ? AND p.hidden = 0 ORDER BY p.created_at DESC LIMIT ?";
        params = [username, limit];
      }
    } else {
      // Regular timeline query (For You tab)
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? ${blockFilter} ORDER BY p.created_at DESC LIMIT ?`;
        params = [cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ORDER BY p.created_at DESC LIMIT ?`;
        params = [fetchLimit];
      }
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!result.success) {
      console.error('Database query failed:', result);
      return c.json({ error: 'Failed to fetch posts' }, 500);
    }

    const rawPosts = result.results || [];

    // Shared first pages (For You / hashtag) fetch without the SQL block filter
    // so the cache can be shared across users; apply the block list in JS here
    // and trim back to the requested page size.
    const posts =
      !cursor && !following && !username
        ? (await filterBlockedAuthors(c.env.DB, currentUserId, rawPosts)).slice(0, limit)
        : rawPosts;

    // Parallel: fresh/bookmark status, poll enrichment, vector embedding check
    await Promise.all([
      // Fresh and bookmark status for current user
      (async () => {
        if (!currentUserId || posts.length === 0) return;
        const postIds = posts.map((p: Record<string, unknown>) => String(p.id));
        const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
        posts.forEach((post: Record<string, unknown>) => {
          post.is_freshed = freshed.has(post.id as string);
          post.is_bookmarked = bookmarked.has(post.id as string);
        });
      })(),
      // Poll enrichment
      enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId),
      // Quote enrichment
      enrichPostsWithQuotes(posts as PostRow[], c.env.DB),
      enrichPostsWithAttachments(posts as PostRow[], c.env.DB),
      // Reaction enrichment
      enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId),
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
            embedPost(c.env.DB, c.env, p.id, p.text).catch((e) => console.error('Background embed failed:', e));
          }
        }
      })(),
    ]);

    // Write to KV cache (first page only). Shared feeds cache the raw
    // (unblocked) post list so any user's block list can be applied on read.
    if (!cursor && c.env.CACHE) {
      const cacheKey = makeCacheKey(
        'timeline',
        c,
        `${limit}:${hashtag || ''}:${following ? 'following' : ''}:${username || ''}`,
        !following,
      );
      const cacheData = {
        posts: (rawPosts as Record<string, unknown>[]).map((p) => ({ ...p, is_freshed: false, is_bookmarked: false })),
      };
      await kvCacheSet(c, cacheKey, cacheData, 15);
    }

    // Return total count when filtering by hashtag
    if (hashtag) {
      const countResult = await c.env.DB.prepare(`
        SELECT COUNT(*) as count FROM posts WHERE status = 'published' AND hidden = 0 AND parent_id IS NULL AND id IN (SELECT posts.id FROM posts, json_each(posts.hashtags) WHERE value = ?)
      `)
        .bind(hashtag)
        .first<{ count: number }>();
      return c.json({ posts, count: countResult?.count || 0 });
    }

    return c.json({ posts });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Posts fetch error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/posts/trending - get trending posts based on engagement and time decay
posts.get('/posts/trending', async (c) => {
  try {
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
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

    // Get current user for fresh status
    let currentUserId: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    if (sessionData) {
      currentUserId = sessionData.user.id;
    }

    // Try cache hit (only for non-cursor requests)
    if (!cursor) {
      const cacheKey = makeCacheKey('trending', c, `${limit}`, false);
      const cached = await kvCacheGet<{ posts: Record<string, unknown>[] }>(c, cacheKey);
      if (cached) {
        // User-agnostic cache: re-apply the current user's block list.
        const posts = await filterBlockedAuthors(c.env.DB, currentUserId, cached.posts);
        if (currentUserId && posts.length > 0) {
          const postIds = posts.map((p) => String(p.id));
          const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
          posts.forEach((post) => {
            post.is_freshed = freshed.has(post.id as string);
            post.is_bookmarked = bookmarked.has(post.id as string);
          });
        }
        await enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId);
        await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
        await enrichPostsWithAttachments(posts as PostRow[], c.env.DB);
        await enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId);
        return c.json({ posts });
      }
    }

    // Trending algorithm:
    //   base_score = (fresh*2 + reply*3 + impression*0.1 + 1) / (hours+2)^1.5
    //   adjusted by content type weights and quality score
    const trendingFetchLimit = limit * 5;
    const query = `
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
      COALESCE(p.reply_count, 0) as reply_count,
      COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
      ((p.fresh_count * 2.0 + COALESCE(p.reply_count, 0) * 3.0 + p.impressions * 0.1 + 1.0) /
      EXP(1.5 * LN((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0))) as score
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at > datetime('now', '-7 days')
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
        `SELECT u.id, u.display_name, u.bio, u.avatar_key, u.badge_type, u.created_at,
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
      const qualityScore = computeQualityScore(String(p.text || ''), !!(p.payload_key || p.swf_key), 0);
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

    // Add fresh and bookmark status for current user if logged in
    if (currentUserId && visiblePosts.length > 0) {
      const postIds = visiblePosts.map((p: Record<string, unknown>) => String(p.id));
      const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
      visiblePosts.forEach((post: Record<string, unknown>) => {
        post.is_freshed = freshed.has(post.id as string);
        post.is_bookmarked = bookmarked.has(post.id as string);
      });
    }

    await enrichPostsWithPolls(visiblePosts as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(visiblePosts as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(visiblePosts as PostRow[], c.env.DB);
    await enrichPostsWithReactions(visiblePosts as PostRow[], c.env.DB, currentUserId);

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
      await kvCacheSet(c, cacheKey, cacheData, 30);
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

function diversifyPosts(
  items: Array<{ post: Record<string, unknown>; score: number }>,
  maxCount: number,
  maxPerUser: number,
): Array<{ post: Record<string, unknown>; score: number }> {
  const userCounts = new Map<string, number>();
  const result: Array<{ post: Record<string, unknown>; score: number }> = [];
  for (const item of items) {
    if (result.length >= maxCount) break;
    const userId = String(item.post.user_id || '');
    const count = userCounts.get(userId) || 0;
    if (count >= maxPerUser) continue;
    userCounts.set(userId, count + 1);
    result.push(item);
  }
  return result;
}

const RECOMMENDED_SELECT = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
  COALESCE(p.reply_count, 0) as reply_count, 
  COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at`;

// GET /api/posts/recommended - get recommended posts for the user (vector hybrid)
posts.get('/posts/recommended', async (c) => {
  try {
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const cursor = c.req.query('cursor');
    let cursorScore: string | null = null;
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      const parts = cursor.split(',');
      cursorScore = parts[0] || null;
      cursorCreatedAt = parts[1] || null;
      cursorId = parts[2] || null;
    }
    let numericCursor = cursorScore !== null ? parseFloat(cursorScore) : null;
    if (Number.isNaN(numericCursor!)) numericCursor = null;

    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const currentUserId = c.get('user')?.id;

    // Build user interest vector from Fresh history + game dwell signals.
    // Uses the materialized user_profiles vector (5-min TTL) instead of
    // re-deriving and JSON-parsing up to 100 embeddings on every request.
    let interestVector: number[] | null = null;
    if (currentUserId) {
      const profile = await loadOrComputeInterestVector(c.env.DB, currentUserId);
      interestVector = profile?.vector ?? null;
    }

    // Try hybrid vector-based recommendations if we have an interest vector
    let enrichedPosts: Record<string, unknown>[] = [];
    let nextCursor: string | null = null;

    if (interestVector) {
      let vectorMatches: Array<{ id: string; score: number }> = [];
      const vectorize = c.env.VECTORIZE;

      if (vectorize) {
        try {
          const queryResult = await vectorize.query(interestVector, {
            topK: 100,
            returnValues: false,
            returnMetadata: false,
          });
          vectorMatches = (queryResult.matches || []).map((m) => ({ id: m.id, score: m.score }));
          vectorMatches = vectorMatches.slice(0, 80);
        } catch (e) {
          console.error('Vectorize query failed, falling back to D1:', e);
        }
      }

      // Fallback: compute cosine similarity from D1 post_embeddings
      if (vectorMatches.length === 0) {
        const allEmbedRows = await c.env.DB.prepare(
          'SELECT post_id, embedding FROM post_embeddings ORDER BY created_at DESC LIMIT 300',
        ).all<{
          post_id: string;
          embedding: string;
        }>();
        for (const row of allEmbedRows.results || []) {
          try {
            const v = JSON.parse(row.embedding);
            if (Array.isArray(v)) {
              const sim = cosineSimilarity(interestVector, v);
              vectorMatches.push({ id: row.post_id, score: sim });
            }
          } catch {
            /* skip */
          }
        }
        vectorMatches.sort((a, b) => b.score - a.score);
        vectorMatches = vectorMatches.slice(0, 80);
      }

      if (vectorMatches.length > 0) {
        const candidateIds = vectorMatches.map((m) => m.id);
        const engFormula = `(p.engagement_hotness / EXP(1.5 * LN((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0)))`;
        const candidateQuery = `${RECOMMENDED_SELECT}, ${engFormula} as eng_score FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id IN (${candidateIds.map(() => '?').join(',')}) AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL`;
        const candResult = await c.env.DB.prepare(candidateQuery)
          .bind(...candidateIds)
          .all();
        const candidatePosts = (candResult.results || []) as Array<Record<string, unknown>>;

        if (candidatePosts.length > 0) {
          // Filter out posts from blocked users
          if (currentUserId) {
            const blockedIds = await c.env.DB.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?')
              .bind(currentUserId)
              .all<{ blocked_id: string }>();
            if (blockedIds.success && blockedIds.results.length > 0) {
              const blockedSet = new Set(blockedIds.results.map((r) => r.blocked_id));
              const filteredPosts = candidatePosts.filter((p) => !blockedSet.has(p.user_id as string));
              if (filteredPosts.length < candidatePosts.length) {
                candidatePosts.length = 0;
                candidatePosts.push(...filteredPosts);
              }
            }
          }
          const engScores = candidatePosts.map((p) => Number(p.eng_score) || 0);
          const maxEng = Math.max(...engScores, 1);
          const vecScoreMap = new Map(vectorMatches.map((m) => [m.id, m.score]));
          const maxVec = Math.max(...vectorMatches.map((m) => m.score), 1);

          // Compute author quality scores
          const authorQualityMap = new Map<string, number>();
          const authorIds = [...new Set(candidatePosts.map((p) => p.user_id as string))].filter(Boolean);
          if (authorIds.length > 0) {
            const authorRows = await c.env.DB.prepare(
              `SELECT u.id, u.display_name, u.bio, u.avatar_key, u.badge_type, u.created_at,
                COALESCE(SUM(p.fresh_count), 0) as total_fresh,
                COALESCE(SUM(p.reply_count), 0) as total_reply,
                COALESCE(SUM(p.impressions), 0) as total_impressions,
                COUNT(p.id) as post_count
               FROM users u
               LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'published'
               WHERE u.id IN (${authorIds.map(() => '?').join(',')})
               GROUP BY u.id`,
            )
              .bind(...authorIds)
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
              authorQualityMap.set(row.id, 0.5 + authorQuality);
            }
          }

          const hybrid = candidatePosts.map((p) => {
            const vecSim = (vecScoreMap.get(p.id as string) || 0) / maxVec;
            const engNorm = (Number(p.eng_score) || 0) / maxEng;
            const qualityScore = computeQualityScore(String(p.text || ''), !!(p.payload_key || p.swf_key), 0);
            const typeFactor = (() => {
              const w = getTypeWeights(p.payload_key as string | null, p.swf_key as string | null);
              return (w.fresh + w.reply + w.impression) / 4.5;
            })();
            const authorQuality = authorQualityMap.get(p.user_id as string) || 1.0;
            const fresh = freshnessBoost(p.created_at as string);
            return {
              post: p,
              score: (0.7 * vecSim + 0.3 * engNorm) * qualityScore * typeFactor * authorQuality * fresh,
            };
          });

          hybrid.sort((a, b) => {
            const diff = b.score - a.score;
            if (diff !== 0) return diff;
            const ca = String(b.post.created_at || '').localeCompare(String(a.post.created_at || ''));
            if (ca !== 0) return ca;
            return String(b.post.id || '').localeCompare(String(a.post.id || ''));
          });

          let filtered = hybrid;
          if (numericCursor !== null && cursorCreatedAt) {
            filtered = hybrid.filter((h) => {
              const s = h.score;
              const ca = String(h.post.created_at || '');
              const id = String(h.post.id || '');
              return (
                s < numericCursor! ||
                (s === numericCursor && ca < cursorCreatedAt) ||
                (s === numericCursor && ca === cursorCreatedAt && id < cursorId!)
              );
            });
          }

          const page = diversifyPosts(filtered, limit, 3);
          const posts = page.map((h) => {
            const p = h.post;
            p.score = h.score;
            return p;
          });

          enrichedPosts = await enrichRecommendedPosts(posts, c.env.DB, currentUserId, c);
          if (enrichedPosts.length > 0) {
            const last = enrichedPosts[enrichedPosts.length - 1] as Record<string, unknown>;
            nextCursor = `${last.score},${last.created_at},${last.id}`;
          }
        }
      }
    }

    // Fallback: when no interest vector OR hybrid returned nothing
    if (enrichedPosts.length === 0) {
      const scoreFormula = `(p.engagement_hotness / EXP(1.5 * LN((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0)))`;
      const fetchLimit = limit * 5;
      const blockFilterRecommended = currentUserId
        ? 'AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)'
        : '';
      const blockParamRecommended = currentUserId ? [currentUserId] : [];

      // Fetch raw engagement-based candidates, then re-rank with quality/type/author weights
      const rawQuery = `${RECOMMENDED_SELECT}, ${scoreFormula} as score FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${currentUserId ? 'AND p.user_id != ?' : ''} ${blockFilterRecommended} ORDER BY score DESC, p.created_at DESC LIMIT ?`;
      const rawParams: Array<unknown> = currentUserId
        ? [currentUserId, ...blockParamRecommended, fetchLimit]
        : [...blockParamRecommended, fetchLimit];
      const result = await c.env.DB.prepare(rawQuery)
        .bind(...rawParams)
        .all();
      const rawPosts = (result.results || []) as Record<string, unknown>[];

      // Compute author quality scores
      const authorQualityMap = new Map<string, number>();
      const authorIds = [...new Set(rawPosts.map((p) => p.user_id as string))].filter(Boolean);
      if (authorIds.length > 0) {
        const authorRows = await c.env.DB.prepare(
          `SELECT u.id, u.display_name, u.bio, u.avatar_key, u.badge_type, u.created_at,
              COALESCE(SUM(p.fresh_count), 0) as total_fresh,
              COALESCE(SUM(p.reply_count), 0) as total_reply,
              COALESCE(SUM(p.impressions), 0) as total_impressions,
              COUNT(p.id) as post_count
             FROM users u
             LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'published'
             WHERE u.id IN (${authorIds.map(() => '?').join(',')})
             GROUP BY u.id`,
        )
          .bind(...authorIds)
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
          authorQualityMap.set(row.id, 0.5 + authorQuality);
        }
      }

      // Re-rank with quality score, type weights, and author quality
      const reranked = rawPosts.map((p) => {
        const qualityScore = computeQualityScore(String(p.text || ''), !!(p.payload_key || p.swf_key), 0);
        const typeFactor = (() => {
          const w = getTypeWeights(p.payload_key as string | null, p.swf_key as string | null);
          return (w.fresh + w.reply + w.impression) / 4.5;
        })();
        const authorQuality = authorQualityMap.get(p.user_id as string) || 1.0;
        const rawScore = Number(p.score) || 0;
        const fresh = freshnessBoost(p.created_at as string);
        return { post: p, score: rawScore * qualityScore * typeFactor * authorQuality * fresh };
      });

      // Cursor filter
      let filtered = reranked;
      if (numericCursor !== null && cursorCreatedAt) {
        filtered = reranked.filter((s) => {
          const ca = String(s.post.created_at || '');
          const id = String(s.post.id || '');
          return (
            s.score < numericCursor! ||
            (s.score === numericCursor && ca < cursorCreatedAt!) ||
            (s.score === numericCursor && ca === cursorCreatedAt && id < cursorId!)
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

      const diverse = diversifyPosts(filtered, limit, 3);
      const pagePosts = diverse.map((d) => {
        d.post.score = d.score;
        return d.post;
      });
      enrichedPosts = await enrichRecommendedPosts(pagePosts, c.env.DB, currentUserId, c);
      nextCursor =
        enrichedPosts.length > 0
          ? `${(enrichedPosts[enrichedPosts.length - 1] as Record<string, unknown>).score},${(enrichedPosts[enrichedPosts.length - 1] as Record<string, unknown>).created_at},${(enrichedPosts[enrichedPosts.length - 1] as Record<string, unknown>).id}`
          : null;
    }

    return c.json({ posts: enrichedPosts, next_cursor: nextCursor });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Recommended posts error:', error);
    return c.json({ error: 'Internal server error', details: err.message }, 500);
  }
});

async function enrichRecommendedPosts(
  posts: Record<string, unknown>[],
  db: D1Database,
  currentUserId: string | null | undefined,
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): Promise<Record<string, unknown>[]> {
  if (posts.length === 0) return [];
  if (currentUserId) {
    const postIds = posts.map((p) => String(p.id));
    const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(db, currentUserId, postIds);
    posts.forEach((p) => {
      p.is_freshed = freshed.has(p.id as string);
      p.is_bookmarked = bookmarked.has(p.id as string);
    });
  }
  await enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId);
  await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
  await enrichPostsWithAttachments(posts as PostRow[], c.env.DB);
  await enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId);
  return posts;
}

// GET /api/posts/:id/similar - get similar posts based on vector embedding
posts.get('/posts/:id/similar', async (c) => {
  try {
    const postId = c.req.param('id');
    const limit = Math.min(Number(c.req.query('limit') || '5'), 20);
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const currentUserId = c.get('user')?.id;

    // Get the post's embedding
    const embedRow = await c.env.DB.prepare('SELECT embedding FROM post_embeddings WHERE post_id = ?')
      .bind(postId)
      .first<{ embedding: string }>();
    if (!embedRow) return c.json({ posts: [] });

    let vector: number[];
    try {
      vector = JSON.parse(embedRow.embedding);
    } catch {
      return c.json({ posts: [] });
    }
    if (!Array.isArray(vector)) return c.json({ posts: [] });

    // Query Vectorize
    let similarIds: string[] = [];
    const vectorize = c.env.VECTORIZE;
    if (vectorize) {
      try {
        const result = await vectorize.query(vector, { topK: limit + 1, returnValues: false, returnMetadata: false });
        similarIds = (result.matches || [])
          .map((m) => m.id)
          .filter((id) => id !== postId)
          .slice(0, limit);
      } catch (e) {
        console.error('Vectorize query for similar failed:', e);
      }
    }

    // Fallback: D1 cosine similarity
    if (similarIds.length === 0) {
      const allRows = await c.env.DB.prepare(
        'SELECT post_id, embedding FROM post_embeddings ORDER BY created_at DESC LIMIT 100',
      ).all<{
        post_id: string;
        embedding: string;
      }>();
      const scored: Array<{ id: string; sim: number }> = [];
      for (const row of allRows.results || []) {
        if (row.post_id === postId) continue;
        try {
          const v = JSON.parse(row.embedding);
          if (Array.isArray(v)) scored.push({ id: row.post_id, sim: cosineSimilarity(vector, v) });
        } catch {
          /* skip */
        }
      }
      scored.sort((a, b) => b.sim - a.sim);
      similarIds = scored.slice(0, limit).map((s) => s.id);
    }

    if (similarIds.length === 0) return c.json({ posts: [] });

    const postsResult = await c.env.DB.prepare(
      `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id IN (${similarIds.map(() => '?').join(',')})`,
    )
      .bind(...similarIds)
      .all();
    const posts = postsResult.results || [];

    if (currentUserId && posts.length > 0) {
      const pids = posts.map((p: Record<string, unknown>) => String(p.id));
      const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, pids);
      posts.forEach((p: Record<string, unknown>) => {
        p.is_freshed = freshed.has(p.id as string);
        p.is_bookmarked = bookmarked.has(p.id as string);
      });
    }

    await enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(posts as PostRow[], c.env.DB);
    await enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId);

    return c.json({ posts });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Similar posts error:', error);
    return c.json({ error: 'Internal server error', details: err.message }, 500);
  }
});

// GET /api/ads/active - get active ads (public endpoint)
posts.post('/posts/:id/impression', async (c) => {
  try {
    const postId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(
      'UPDATE posts SET impressions = impressions + 1, engagement_hotness = engagement_hotness + 0.1 WHERE id = ?',
    )
      .bind(postId)
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to record impression' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record post impression error:', error);
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({ ok: true, warning: 'Impression tracking failed but content can still be displayed' });
  }
});

// POST /api/posts/impressions/batch - track multiple post impressions (public endpoint)
posts.post('/posts/impressions/batch', async (c) => {
  try {
    const body = (await c.req.json()) as { post_ids: string[] };

    if (!body.post_ids || !Array.isArray(body.post_ids) || body.post_ids.length === 0) {
      return c.json({ error: 'Invalid request: post_ids array required' }, 400);
    }

    if (body.post_ids.length > 100) {
      return c.json({ error: 'Too many post IDs (max 100)' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Create placeholders for batch update
    const placeholders = body.post_ids.map(() => '?').join(',');
    const result = await c.env.DB.prepare(
      `UPDATE posts SET impressions = impressions + 1, engagement_hotness = engagement_hotness + 0.1 WHERE id IN (${placeholders})`,
    )
      .bind(...body.post_ids)
      .run();

    if (!result.success) {
      console.error('Batch database update failed:', result);
      return c.json({ error: 'Failed to record impressions' }, 500);
    }

    return c.json({ ok: true, updated: result.meta?.changes || 0 });
  } catch (error: unknown) {
    console.error('Batch post impressions error:', error);
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({
      ok: true,
      updated: 0,
      warning: 'Batch impression tracking failed but content can still be displayed',
    });
  }
});

// POST /api/ads/:id/click - track ad click (public endpoint)
posts.post('/posts/:id/prepare-attachment', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id');
    const { filename } = await c.req.json();

    if (!filename) return c.json({ error: 'Missing filename' }, 400);

    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const post = await c.env.DB.prepare('SELECT id, user_id, status FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ id: string; user_id: string; status: string } | null>();

    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Cannot edit this post' }, 400);

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];

    let storageKey: string;
    let keyType: string;

    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `swf/${postId}.swf`;
      keyType = 'swf';
    } else if (name.endsWith('.zip')) {
      storageKey = `zip/${postId}.zip`;
      keyType = 'payload';
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `html/${postId}.html`;
      keyType = 'payload';
    } else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `audio/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `video/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = {
        png: '.png',
        jpg: '.jpg',
        jpeg: '.jpg',
        gif: '.gif',
        webp: '.webp',
        svg: '.svg',
        bmp: '.bmp',
        ico: '.ico',
      };
      storageKey = `gif/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else {
      const safeExt = ext ? `.${ext}` : '';
      storageKey = `payload/${postId}${safeExt}`;
      keyType = 'payload';
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;

    return c.json({ uploadUrl, key: storageKey, keyType });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Prepare attachment error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/posts/:id/prepare-media — reserve an upload slot for one more
// image/audio/video attachment on an existing published post (protected).
posts.post('/posts/:id/prepare-media', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id');
    const { filename, contentType, reservedKeys } = (await c.req.json()) as {
      filename?: string;
      contentType?: string;
      reservedKeys?: unknown;
    };

    if (!postId) return c.json({ error: 'Missing post id' }, 400);
    if (!filename) return c.json({ error: 'Missing filename' }, 400);
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const kind = kindFromUpload(filename, contentType);
    if (!kind) return c.json({ error: 'Only image, audio, and video files are allowed' }, 400);

    const post = await c.env.DB.prepare('SELECT id, user_id, status FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ id: string; user_id: string; status: string } | null>();
    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Cannot edit this post' }, 400);

    // Slots already spoken for. `reservedKeys` is the client's full planned
    // list for this edit session (attachments it keeps plus slots it has
    // already prepared but not yet committed) — without it every call in one
    // session would be handed the same slot. Falls back to the stored rows
    // for callers that do not send the list.
    const plannedKeys: string[] = [];
    if (Array.isArray(reservedKeys)) {
      for (const k of reservedKeys) {
        if (typeof k === 'string' && parseAttachmentKey(k)?.postId === postId) plannedKeys.push(k);
      }
    } else {
      const existing = await c.env.DB.prepare('SELECT r2_key FROM post_attachments WHERE post_id = ?')
        .bind(postId)
        .all<{ r2_key: string }>();
      plannedKeys.push(...(existing.results || []).map((r) => r.r2_key));
    }

    const maxAttachments = await resolveAttachmentLimit(c.env, user.id);

    if (plannedKeys.length + 1 > maxAttachments) {
      return c.json({ error: `Maximum ${maxAttachments} attachments allowed` }, 400);
    }

    // Occupancy comes from the slot embedded in the R2 key, not the
    // position column: sequenceAttachments renumbers positions on save while
    // keys keep their original slot, so the two drift after any removal.
    const usedSlots = new Set<number>();
    for (const planned of plannedKeys) {
      const parsed = parseAttachmentKey(planned);
      if (parsed) usedSlots.add(parsed.position);
    }

    let key: string | null = null;
    for (let p = 1; p <= maxAttachments && !key; p++) {
      if (usedSlots.has(p)) continue;
      const candidate = buildAttachmentKey(postId, p, filename, contentType);
      if (!candidate) return c.json({ error: 'Invalid filename' }, 400);
      // Skip a slot whose object still exists in R2 but is not planned for
      // the save (dropped attachment not committed yet, or a stale orphan) so
      // the upload cannot clobber a post that is still referencing it.
      if (c.env.BUCKET && (await c.env.BUCKET.head(candidate))) continue;
      key = candidate;
    }
    if (!key) return c.json({ error: `Maximum ${maxAttachments} attachments allowed` }, 400);

    const position = parseAttachmentKey(key)?.position ?? 0;
    return c.json({ uploadUrl: `${new URL(c.req.url).origin}/api/upload/${key}`, key, kind, position });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Prepare media error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// Step 1 — POST /api/posts/prepare (protected)
posts.post('/posts/prepare', requireAuth, async (c) => {
  try {
    const body = (await c.req.json()) as {
      filename?: string;
      files?: Array<{ filename?: string; contentType?: string }>;
    };
    const { filename, files } = body;

    // Multi-media attachments (image/audio/video only, plan-dependent max, no html/swf/zip)
    if (Array.isArray(files)) {
      if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);
      const maxAttachments = await resolveAttachmentLimit(c.env, c.get('user')?.id || '');
      if (files.length === 0 || files.length > maxAttachments) {
        return c.json({ error: `Attachments must be 1-${maxAttachments} files` }, 400);
      }

      const postId = crypto.randomUUID();
      const uploads: Array<{ key: string; uploadUrl: string; kind: AttachmentKind }> = [];
      for (const file of files) {
        const name = file?.filename;
        if (typeof name !== 'string' || !name) {
          return c.json({ error: 'Missing filename' }, 400);
        }
        const kind = kindFromUpload(name, file.contentType);
        if (!kind) {
          return c.json({ error: 'Only image, audio, and video files are allowed' }, 400);
        }
        const key = buildAttachmentKey(postId, uploads.length + 1, name, file.contentType);
        if (!key) return c.json({ error: 'Invalid filename' }, 400);
        uploads.push({
          key,
          uploadUrl: `${new URL(c.req.url).origin}/api/upload/${key}`,
          kind,
        });
      }

      const result = await c.env.DB.prepare(
        `INSERT INTO posts (id, user_id, username, text, hashtags, engagement_hotness, status)
         VALUES (?, ?, ?, ?, ?, 1.0, 'pending')`,
      )
        .bind(postId, c.get('user')?.id || '', c.get('user')?.username || 'anonymous', '', '[]')
        .run();

      if (!result.success) {
        return c.json({ error: 'Failed to create pending post' }, 500);
      }

      return c.json({ postId, uploads });
    }

    if (!filename) {
      return c.json({ error: 'Missing filename' }, 400);
    }

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];
    const postId = crypto.randomUUID();

    let storageKey: string;
    let keyColumn: string;
    let responseType: 'gif' | 'zip' | 'swf';

    // SWF files
    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `swf/${postId}.swf`;
      keyColumn = 'swf_key';
      responseType = 'swf';
    }
    // ZIP files
    else if (name.endsWith('.zip')) {
      storageKey = `zip/${postId}.zip`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }
    // HTML files
    else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `html/${postId}.html`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }
    // Audio files by extension
    else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `audio/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Video files by extension
    else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `video/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Image files by extension
    else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = {
        png: '.png',
        jpg: '.jpg',
        jpeg: '.jpg',
        gif: '.gif',
        webp: '.webp',
        svg: '.svg',
        bmp: '.bmp',
        ico: '.ico',
      };
      storageKey = `gif/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Fallback: store as generic payload with original extension
    else {
      const safeExt = ext ? `.${ext}` : '';
      storageKey = `payload/${postId}${safeExt}`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, ${keyColumn}, engagement_hotness, status)
      VALUES (?, ?, ?, ?, ?, ?, 1.0, 'pending')
    `)
      .bind(postId, c.get('user')?.id || '', c.get('user')?.username || 'anonymous', '', '[]', storageKey)
      .run();

    if (!result.success) {
      return c.json({ error: 'Failed to create pending post' }, 500);
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;
    const resp: Record<string, unknown> = { postId };

    if (responseType === 'zip') {
      resp.zipUploadUrl = uploadUrl;
      resp.zipKey = storageKey;
    } else if (responseType === 'swf') {
      resp.swfUploadUrl = uploadUrl;
      resp.swfKey = storageKey;
    } else {
      resp.gifUploadUrl = uploadUrl;
      resp.gifKey = storageKey;
    }

    return c.json(resp);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Prepare post error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// Helper: extract game description from a game ZIP in R2
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

// Step 3 — POST /api/posts/commit (protected)
posts.post('/posts/commit', requireAuth, async (c) => {
  try {
    const contentType = c.req.header('content-type');
    let postId: string | undefined;
    let gifKey: string | undefined;
    let swfKey: string | undefined;
    let text: string;
    let requestHashtags: string[] = [];
    let pollData: any;
    let zipKey: string | undefined;
    let thumbnailKey: string | undefined;
    let quotedPostId: string | undefined;
    let attachmentInputs: AttachmentInput[] | undefined;

    if (contentType?.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      text = formData.get('text') as string;
      postId = (formData.get('postId') as string) || undefined;
      gifKey = (formData.get('gifKey') as string) || undefined;
      swfKey = (formData.get('swfKey') as string) || undefined;
      zipKey = (formData.get('payloadKey') as string) || undefined;
      quotedPostId = (formData.get('quotedPostId') as string) || undefined;
      const pollStr = formData.get('poll') as string;
      pollData = pollStr ? JSON.parse(pollStr) : undefined;
      const attachmentsStr = formData.get('attachments') as string | null;
      if (attachmentsStr) attachmentInputs = JSON.parse(attachmentsStr);

      const thumbnailFile = (formData.get('thumbnail') as File | null) || undefined;
      if (thumbnailFile && thumbnailFile.size > 0) {
        if (thumbnailFile.size > 1024 * 1024) {
          return c.json({ error: 'Thumbnail must be ≤1MB' }, 400);
        }
        const allowedExts = ['jpg', 'jpeg', 'png', 'gif'];
        const ext = thumbnailFile.name.toLowerCase().split('.').pop();
        if (!ext || !allowedExts.includes(ext)) {
          return c.json({ error: 'Thumbnail must be .jpg, .jpeg, .png, or .gif' }, 400);
        }
        const thumbnailR2Key = `payload/${postId || crypto.randomUUID()}.thumb.${ext}`;
        const thumbnailBuffer = await thumbnailFile.arrayBuffer();
        const thumbnailDimError = validateImageDimensions(thumbnailBuffer, thumbnailFile.type);
        if (thumbnailDimError) {
          return c.json({ error: `Thumbnail too large. ${thumbnailDimError}` }, 413);
        }
        await c.env.BUCKET.put(thumbnailR2Key, thumbnailBuffer, {
          httpMetadata: { contentType: thumbnailFile.type },
        });
        thumbnailKey = thumbnailR2Key;
      }
    } else {
      const body = await c.req.json();
      postId = body.postId;
      gifKey = body.gifKey;
      swfKey = body.swfKey;
      text = body.text;
      requestHashtags = body.hashtags || [];
      pollData = body.poll;
      zipKey = body.zipKey;
      thumbnailKey = body.thumbnailKey;
      quotedPostId = body.quotedPostId;
      attachmentInputs = body.attachments;
    }
    const payloadKey = zipKey;
    const userId = c.get('user')?.id || '';
    const username = c.get('user')?.username || 'anonymous';

    // Validate multi-media attachments (image/audio/video, plan-dependent max)
    if (attachmentInputs !== undefined) {
      const maxAttachments = await resolveAttachmentLimit(c.env, userId);
      const attachmentError = validateAttachmentInputs(attachmentInputs, maxAttachments);
      if (attachmentError) return c.json({ error: attachmentError }, 422);
      if (gifKey || swfKey || payloadKey || thumbnailKey) {
        return c.json({ error: 'Cannot combine attachments with game payloads' }, 422);
      }
    }

    // Reject overwriting another user's post through the upsert path
    if (postId) {
      const existingOwner = (await c.env.DB.prepare('SELECT user_id FROM posts WHERE id = ?')
        .bind(postId)
        .first<{ user_id: string }>()) as { user_id: string } | null;
      if (existingOwner && existingOwner.user_id !== userId) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }

    // Validate text (empty allowed only for quotes)
    const hasQuote = Boolean(quotedPostId);
    if (!text) text = '';
    if (text.length > 200 || (!hasQuote && text.length < 1)) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422);
    }

    // Validate hashtags
    if (!Array.isArray(requestHashtags) || requestHashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422);
    }

    for (const tag of requestHashtags) {
      if (
        typeof tag !== 'string' ||
        tag.length > 20 ||
        !/^[a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(tag)
      ) {
        return c.json({ error: 'Hashtags must be alphanumeric, Japanese characters, and ≤20 chars' }, 422);
      }
    }

    // Extract hashtags from text
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
    const hashtagSet = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtagSet.add(match[1]);
    }
    const hashtags = Array.from(hashtagSet);

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
    const mentionSet = new Set<string>();
    let mentionMatch: RegExpExecArray | null;
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1]);
    }
    const mentionedUsernames = Array.from(mentionSet);

    // Resolve mentions
    const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, username);

    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available');
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate quoted post reference if provided
    let quotedPostAuthorId: string | null = null;
    if (quotedPostId) {
      const quoted = (await c.env.DB.prepare('SELECT id, user_id, status FROM posts WHERE id = ?')
        .bind(quotedPostId)
        .first()) as { id: string; user_id: string; status: string } | null;

      if (!quoted || quoted.status !== 'published') {
        return c.json({ error: 'Quoted post not found' }, 404);
      }
      quotedPostAuthorId = quoted.user_id;
    }

    if (!postId) postId = crypto.randomUUID();

    // Attachments must target this post and fit the total size budget
    const attachments = attachmentInputs !== undefined ? sequenceAttachments(attachmentInputs) : [];
    if (attachments.length > 0) {
      for (const att of attachments) {
        if (parseAttachmentKey(att.r2_key)?.postId !== postId) {
          return c.json({ error: 'Attachment does not belong to this post' }, 422);
        }
      }
      const sizeCheck = await sumAttachmentSizes(
        c.env.BUCKET,
        attachments.map((a) => a.r2_key),
      );
      if (sizeCheck.error) return c.json({ error: sizeCheck.error }, 413);
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, payload_key, gif_key, swf_key, thumbnail_key, quoted_post_id, engagement_hotness, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 'published')
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        hashtags = excluded.hashtags,
        mentions = excluded.mentions,
        payload_key = COALESCE(excluded.payload_key, posts.payload_key),
        gif_key = COALESCE(excluded.gif_key, posts.gif_key),
        swf_key = COALESCE(excluded.swf_key, posts.swf_key),
        thumbnail_key = COALESCE(excluded.thumbnail_key, posts.thumbnail_key),
        quoted_post_id = COALESCE(excluded.quoted_post_id, posts.quoted_post_id),
        status = 'published'
    `)
      .bind(
        postId,
        userId,
        username,
        text,
        JSON.stringify(hashtags),
        mentionsJson,
        payloadKey || null,
        gifKey || null,
        swfKey || null,
        thumbnailKey || null,
        quotedPostId || null,
      )
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to create post', details: result }, 500);
    }

    // Persist multi-media attachments (full replacement for idempotent commits)
    if (attachments.length > 0) {
      const previous =
        (
          await c.env.DB.prepare('SELECT r2_key FROM post_attachments WHERE post_id = ?')
            .bind(postId)
            .all<{ r2_key: string }>()
        ).results || [];
      const nextKeySet = new Set(attachments.map((a) => a.r2_key));
      const dropped = previous.map((r) => r.r2_key).filter((k) => !nextKeySet.has(k));
      if (dropped.length > 0 && c.env.BUCKET) {
        await Promise.all(dropped.map((k) => c.env.BUCKET.delete(k).catch(() => {})));
      }
      const attStmts = [
        c.env.DB.prepare('DELETE FROM post_attachments WHERE post_id = ?').bind(postId),
        ...attachments.map((att) =>
          c.env.DB.prepare('INSERT INTO post_attachments (post_id, r2_key, kind, position) VALUES (?, ?, ?, ?)').bind(
            postId,
            att.r2_key,
            att.kind,
            att.position,
          ),
        ),
      ];
      await c.env.DB.batch(attStmts);
    }

    // Create poll if poll data was provided
    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      try {
        const pollId = crypto.randomUUID();
        await c.env.DB.prepare(`
          INSERT INTO polls (id, post_id, question, multiple_choice, ends_at)
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(pollId, postId, pollData.question, pollData.multipleChoice ? 1 : 0, pollData.endsAt || null)
          .run();

        const optionIds: string[] = [];
        const optionStmts = pollData.options.map((label: string) => {
          const optId = crypto.randomUUID();
          optionIds.push(optId);
          return c.env.DB.prepare('INSERT INTO poll_options (id, poll_id, label) VALUES (?, ?, ?)').bind(
            optId,
            pollId,
            label,
          );
        });
        await c.env.DB.batch(optionStmts);
      } catch (e) {
        console.error('Failed to create poll:', e);
        // Don't fail post creation if poll creation fails
      }
    }

    // Create mention notifications for mentioned users (skip self-mentions, quoted author, and duplicates)
    if (mentionedUsernames.length > 0) {
      try {
        const mentionData = JSON.parse(mentionsJson) as Array<{ username: string; user_id: string }>;
        const seenMentionUserIds = new Set<string>();
        const mentionTargets = mentionData.filter((m) => {
          if (m.user_id === userId) return false;
          // The quoted post author gets a dedicated 'quote' notification below.
          if (m.user_id === quotedPostAuthorId) return false;
          if (seenMentionUserIds.has(m.user_id)) return false;
          seenMentionUserIds.add(m.user_id);
          return true;
        });
        const mentionStmts = mentionTargets.map((m) =>
          c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          ).bind(nanoid(), m.user_id, 'mention', postId, userId),
        );
        if (mentionStmts.length > 0) {
          await c.env.DB.batch(mentionStmts);
        }
        const actor = c.get('user');
        for (const mention of mentionTargets) {
          await sendPushToAll(
            c.env,
            mention.user_id,
            'mention',
            actor?.username,
            actor?.display_name,
            text || '',
            postId,
          );
        }
      } catch (e) {
        // Don't fail the post creation if mention notifications fail
        console.error('Failed to create mention notifications:', e);
      }
    }

    // Create quote notification for the quoted post's author (skip self-quotes)
    if (quotedPostAuthorId && quotedPostAuthorId !== userId) {
      try {
        await c.env.DB.prepare(
          'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(nanoid(), quotedPostAuthorId, 'quote', postId, userId)
          .run();
        const actor = c.get('user');
        await sendPushToAll(
          c.env,
          quotedPostAuthorId,
          'quote',
          actor?.username,
          actor?.display_name,
          text || '',
          postId,
        );
      } catch (e) {
        console.error('Failed to create quote notification:', e);
      }
    }

    // ActivityPub delivery for public posts
    try {
      // Get user info for ActivityPub
      const user = (await c.env.DB.prepare('SELECT id, username, display_name FROM users WHERE id = ?')
        .bind(userId)
        .first()) as { id: string; username: string; display_name: string } | null;

      if (user && c.env.AP_DELIVERY_QUEUE) {
        // Get post details including mentions
        const post = (await c.env.DB.prepare('SELECT id, text, created_at, status, mentions FROM posts WHERE id = ?')
          .bind(postId)
          .first()) as {
          id: string;
          text: string;
          created_at: string;
          status: string;
          mentions: string | null;
        } | null;

        if (post && post.status === 'published') {
          // Build mention actor URLs for CC
          const mentionActorUrls: string[] = [];
          try {
            if (post.mentions) {
              const mentionData = JSON.parse(post.mentions) as Array<{ username: string; user_id: string }>;
              for (const m of mentionData) {
                mentionActorUrls.push(`${c.env.BASE_URL}/actors/${m.username}`);
              }
            }
          } catch {}
          const note = buildNoteObject(post, user, c.env.BASE_URL, mentionActorUrls);
          const activity = buildCreateActivity(note, user, c.env.BASE_URL);

          // Get followers from ap_followers
          const followers = (await c.env.DB.prepare('SELECT inbox_url FROM ap_followers WHERE local_user_id = ?')
            .bind(userId)
            .all()) as { results: Array<{ inbox_url: string }> };

          // Send to queue for each follower
          for (const follower of followers.results) {
            await c.env.AP_DELIVERY_QUEUE.send({
              inboxUrl: follower.inbox_url,
              activity,
              senderUsername: username,
            });
          }
        }
      }
    } catch (e) {
      // Queue not available or other error - skip delivery in development
      console.error('ActivityPub delivery skipped:', String(e));
    }

    // Extract game description from ZIP
    if (payloadKey && payloadKey.endsWith('.zip')) {
      await extractGameDescription(c.env.BUCKET, c.env.DB, payloadKey!, postId!);
    }

    // Fetch the created post for enrichment
    const fullPost = (await c.env.DB.prepare(
      "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key as payloadKey, p.swf_key as swfKey, p.thumbnail_key as thumbnailKey, p.game_description, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?",
    )
      .bind(postId)
      .first()) as PostRow;

    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      try {
        await enrichPostsWithPolls([fullPost], c.env.DB, c.get('user')?.id);
      } catch (e) {
        console.error('Failed to enrich post with poll:', e);
      }
    }

    await enrichPostsWithQuotes([fullPost], c.env.DB);
    await enrichPostsWithAttachments([fullPost], c.env.DB);
    await enrichPostsWithReactions([fullPost], c.env.DB, c.get('user')?.id);

    embedPost(c.env.DB, c.env, fullPost.id, fullPost.text).catch((e) => console.error('Background embed failed:', e));

    // Screen every image the post carries, not just the first: reconcile the
    // scan rows with the current key list, then submit what the throttle allows.
    screenPostImages(c.env.DB, c.env, fullPost.id, [
      ...(isImageKey(fullPost.gif_key) ? [fullPost.gif_key] : []),
      ...imageAttachmentKeys(fullPost.attachments),
    ]).catch((e) => console.error('Background NSFW screen failed:', e));

    // Pre-extract ZIP to R2 for WVFS persistent caching
    if (payloadKey && payloadKey.endsWith('.zip')) {
      const execCtx = (c as any).executionCtx;
      if (execCtx?.waitUntil) {
        execCtx.waitUntil(
          (async () => {
            try {
              await extractZipToR2(c.env.BUCKET, payloadKey!, postId!);
            } catch (e) {
              console.error('Background ZIP extraction failed:', e);
            }
          })(),
        );
      }
    }

    // Pre-copy HTML to WVFS for persistent caching
    if (payloadKey && payloadKey.endsWith('.html')) {
      const execCtx = (c as any).executionCtx;
      if (execCtx?.waitUntil) {
        execCtx.waitUntil(
          (async () => {
            try {
              await copyHtmlToWvfs(c.env.BUCKET, payloadKey!, postId!);
            } catch (e) {
              console.error('Background HTML copy failed:', e);
            }
          })(),
        );
      }
    }

    return c.json({ post: fullPost });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Post creation error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/posts/:id/fresh - toggle Fresh! (protected)
posts.post('/posts/:id/fresh', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const userId = c.get('user')?.id || '';
  const currentUser = c.get('user');

  // Get post to check ownership for notification and remote actor
  const post = (await c.env.DB.prepare(
    "SELECT user_id, actor_id, username, text FROM posts WHERE id = ? AND status = 'published'",
  )
    .bind(postId)
    .first()) as { user_id: string; actor_id: string | null; username: string; text: string } | null;

  if (!post) {
    return c.json({ error: 'Post not found' }, 404);
  }

  // Check if already freshed
  const existing = await c.env.DB.prepare('SELECT * FROM freshs WHERE post_id = ? AND user_id = ?')
    .bind(postId, userId)
    .first();

  if (existing) {
    // Remove fresh
    await c.env.DB.prepare('DELETE FROM freshs WHERE post_id = ? AND user_id = ?').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count - 1, engagement_hotness = engagement_hotness - 2.0 WHERE id = ? RETURNING fresh_count',
    )
      .bind(postId)
      .first<{ fresh_count: number }>();

    return c.json({ freshed: false, fresh_count: result?.fresh_count ?? 0 });
  } else {
    // Add fresh
    await c.env.DB.prepare('INSERT INTO freshs (post_id, user_id) VALUES (?, ?)').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count + 1, engagement_hotness = engagement_hotness + 2.0 WHERE id = ? RETURNING fresh_count',
    )
      .bind(postId)
      .first<{ fresh_count: number }>();

    // Create notification for post author (only if not self-freshing)
    if (post.user_id !== userId) {
      try {
        const existingNotif = (await c.env.DB.prepare(
          "SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = 'fresh' ORDER BY created_at DESC LIMIT 1",
        )
          .bind(post.user_id, postId)
          .first()) as Record<string, unknown>;

        if (existingNotif) {
          const actorData = existingNotif.actor_data
            ? JSON.parse(existingNotif.actor_data as string)
            : existingNotif.actor_id
              ? [existingNotif.actor_id as string]
              : [];
          if (!actorData.includes(userId)) {
            actorData.push(userId);
          }
          await c.env.DB.prepare(
            "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
          )
            .bind(actorData[0], JSON.stringify(actorData), existingNotif.id as string)
            .run();
        } else {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          )
            .bind(nanoid(), post.user_id, 'fresh', postId, userId)
            .run();
          {
            const actor = c.get('user');

            const textPreview = ((post as Record<string, unknown>).text as string) || '';
            await sendPushToAll(
              c.env,
              post.user_id,
              'fresh',
              actor?.username,
              actor?.display_name,
              textPreview,
              postId,
            );
          }
        }
      } catch (e) {
        console.error('Failed to create fresh notification:', e);
      }
    }

    // If the post is from a remote actor, send Like activity
    if (post.actor_id && currentUser && c.env.AP_DELIVERY_QUEUE) {
      try {
        const actorResponse = await fetch(post.actor_id, {
          headers: { Accept: 'application/activity+json, application/ld+json' },
        });
        if (actorResponse.ok) {
          const actorData = (await actorResponse.json()) as ActorData;
          const inboxUrl = actorData.inbox;
          if (inboxUrl) {
            const likeActivity = {
              '@context': 'https://www.w3.org/ns/activitystreams',
              id: `${c.env.BASE_URL}/activities/like-${nanoid()}`,
              type: 'Like',
              actor: `${c.env.BASE_URL}/actors/${currentUser.username}`,
              object: `${c.env.BASE_URL}/notes/${postId}`,
              to: [post.actor_id],
            };
            await c.env.AP_DELIVERY_QUEUE.send({
              type: 'delivery',
              inboxUrl,
              activity: likeActivity,
              senderUsername: currentUser.username,
            });
          }
        }
      } catch (e) {
        console.error('Failed to send Like activity for remote post:', e);
      }
    }

    return c.json({ freshed: true, fresh_count: result?.fresh_count ?? 0 });
  }
});

// POST /api/posts/:id/bookmark - toggle bookmark (protected)
posts.post('/posts/:id/bookmark', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const userId = c.get('user')?.id || '';

  // Verify post exists
  const post = (await c.env.DB.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'")
    .bind(postId)
    .first()) as { id: string } | null;

  if (!post) {
    return c.json({ error: 'Post not found' }, 404);
  }

  // Check if already bookmarked
  const existing = await c.env.DB.prepare('SELECT * FROM bookmarks WHERE post_id = ? AND user_id = ?')
    .bind(postId, userId)
    .first();

  if (existing) {
    await c.env.DB.prepare('DELETE FROM bookmarks WHERE post_id = ? AND user_id = ?').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET bookmark_count = bookmark_count - 1 WHERE id = ? RETURNING bookmark_count',
    )
      .bind(postId)
      .first<{ bookmark_count: number }>();

    return c.json({ bookmarked: false, bookmark_count: result?.bookmark_count ?? 0 });
  } else {
    await c.env.DB.prepare('INSERT INTO bookmarks (post_id, user_id) VALUES (?, ?)').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET bookmark_count = bookmark_count + 1 WHERE id = ? RETURNING bookmark_count',
    )
      .bind(postId)
      .first<{ bookmark_count: number }>();

    return c.json({ bookmarked: true, bookmark_count: result?.bookmark_count ?? 0 });
  }
});

// POST /api/posts/:id/reactions - toggle an emoji reaction on a post (protected)
posts.post('/posts/:id/reactions', requireAuth, async (c) => {
  try {
    await ensureReactionsTable(c.env.DB);
    const postId = c.req.param('id');
    const userId = c.get('user')?.id || '';
    const { emoji } = (await c.req.json()) as { emoji?: string };

    if (typeof emoji !== 'string' || emoji.trim().length === 0) {
      return c.json({ error: 'Invalid emoji' }, 400);
    }
    const cleanEmoji = emoji.trim();
    if (cleanEmoji.length > 32) {
      return c.json({ error: 'Emoji too long' }, 400);
    }

    // Verify post exists
    const post = (await c.env.DB.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'")
      .bind(postId)
      .first()) as { id: string } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const existing = await c.env.DB.prepare('SELECT 1 FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?')
      .bind(postId, userId, cleanEmoji)
      .first();

    if (existing) {
      await c.env.DB.prepare('DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?')
        .bind(postId, userId, cleanEmoji)
        .run();
    } else {
      await c.env.DB.prepare('INSERT INTO reactions (post_id, user_id, emoji) VALUES (?, ?, ?)')
        .bind(postId, userId, cleanEmoji)
        .run();
    }

    const postRow = { id: postId } as PostRow;
    await enrichPostsWithReactions([postRow], c.env.DB, userId);

    return c.json({
      emoji: cleanEmoji,
      reacted: !existing,
      reactions: postRow.reactions || [],
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Reaction toggle error:', error);
    return c.json({ error: 'Failed to toggle reaction', details: err.message }, 500);
  }
});

// GET /api/bookmarks - get bookmarked posts for current user (protected)
posts.get('/bookmarks', requireAuth, async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const userId = c.get('user')?.id || '';

    let query: string;
    const params: Array<unknown> = [userId];

    if (cursor) {
      params.push(cursor);
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN bookmarks b ON b.post_id = p.id AND b.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 AND p.created_at < ?
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
    } else {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN bookmarks b ON b.post_id = p.id AND b.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();
    const posts = result.results || [];

    // All posts fetched from bookmarks are by definition bookmarked
    posts.forEach((post: Record<string, unknown>) => {
      post.is_bookmarked = true;
    });

    await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(posts as PostRow[], c.env.DB);
    await enrichPostsWithReactions(posts as PostRow[], c.env.DB, userId);

    const nextCursor = posts.length === limit ? posts[posts.length - 1].created_at : null;

    return c.json({ posts, nextCursor });
  } catch (error: unknown) {
    console.error('Bookmarks fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/freshs - get current user's Freshed (liked) posts (protected)
posts.get('/freshs', requireAuth, async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const userId = c.get('user')?.id || '';

    let query: string;
    const params: Array<unknown> = [userId];

    if (cursor) {
      params.push(cursor);
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN freshs f ON f.post_id = p.id AND f.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 AND p.created_at < ?
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
    } else {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN freshs f ON f.post_id = p.id AND f.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();
    const posts = result.results || [];

    // All posts fetched here are by definition freshed by the current user
    posts.forEach((post: Record<string, unknown>) => {
      post.is_freshed = true;
    });

    // Enrich bookmark state for these posts
    if (posts.length > 0) {
      const postIds = posts.map((p: Record<string, unknown>) => p.id);
      const bmResult = await c.env.DB.prepare(
        `SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
      )
        .bind(userId, ...postIds)
        .all<{ post_id: string }>();
      const bookmarked = new Set((bmResult.results || []).map((r) => r.post_id));
      posts.forEach((post: Record<string, unknown>) => {
        post.is_bookmarked = bookmarked.has(post.id as string);
      });
    }

    await enrichPostsWithReactions(posts as PostRow[], c.env.DB, userId);
    await enrichPostsWithAttachments(posts as PostRow[], c.env.DB);

    const nextCursor = posts.length === limit ? posts[posts.length - 1].created_at : null;

    return c.json({ posts, nextCursor });
  } catch (error: unknown) {
    console.error('Freshs fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /api/posts/fresh/batch - batch toggle Fresh! for multiple posts (protected)
posts.post('/posts/fresh/batch', requireAuth, async (c) => {
  try {
    const { post_ids, action } = await c.req.json();

    if (!Array.isArray(post_ids) || post_ids.length === 0) {
      return c.json({ error: 'Invalid post_ids array' }, 400);
    }

    if (!['add', 'remove'].includes(action)) {
      return c.json({ error: 'Invalid action. Must be "add" or "remove"' }, 400);
    }

    const userId = c.get('user')?.id || '';
    const maxBatchSize = 50;

    if (post_ids.length > maxBatchSize) {
      return c.json({ error: `Maximum batch size is ${maxBatchSize}` }, 400);
    }

    // Get posts to check ownership for notifications
    const posts = await c.env.DB.prepare(`
      SELECT id, user_id FROM posts WHERE id IN (${post_ids.map(() => '?').join(',')}) AND status = 'published'
    `)
      .bind(...post_ids)
      .all();

    const validPostIds = posts.results?.map((p) => p.id) || [];
    const invalidIds = post_ids.filter((id) => !validPostIds.includes(id));

    if (invalidIds.length > 0) {
      return c.json({ error: 'Some posts not found', invalid_ids: invalidIds }, 404);
    }

    if (action === 'add') {
      // Check which posts are already freshed to avoid duplicates
      const existingFreshes = await c.env.DB.prepare(`
        SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${post_ids.map(() => '?').join(',')})
      `)
        .bind(userId, ...post_ids)
        .all();

      const alreadyFreshed = new Set(existingFreshes.results?.map((f) => f.post_id) || []);
      const toFresh = post_ids.filter((id) => !alreadyFreshed.has(id));

      if (toFresh.length > 0) {
        // Batch insert freshs
        const stmts = toFresh.map((id) =>
          c.env.DB.prepare('INSERT INTO freshs (post_id, user_id) VALUES (?, ?)').bind(id, userId),
        );
        await c.env.DB.batch(stmts);

        // Batch update fresh counts
        await c.env.DB.prepare(`
          UPDATE posts SET fresh_count = fresh_count + 1, engagement_hotness = engagement_hotness + 2.0 WHERE id IN (${toFresh.map(() => '?').join(',')})
        `)
          .bind(...toFresh)
          .run();

        // Create notifications for non-self posts (grouped)
        const nonSelfPosts = posts.results.filter((p) => toFresh.includes(p.id) && p.user_id !== userId);

        if (nonSelfPosts.length > 0) {
          try {
            // Get existing fresh notifications for these posts
            const userPostPairs = nonSelfPosts.map((p) => ({ userId: p.user_id, postId: p.id }));
            const existingNotifs = await c.env.DB.prepare(`
              SELECT id, user_id, post_id, actor_id, actor_data FROM notifications 
              WHERE (user_id, post_id) IN (${userPostPairs.map(() => '(?, ?)').join(',')}) AND type = 'fresh'
            `)
              .bind(...userPostPairs.flatMap((p) => [p.userId, p.postId]))
              .all();

            const existingMap = new Map<string, Record<string, unknown>>();
            for (const row of existingNotifs.results || []) {
              existingMap.set(`${row.user_id}:${row.post_id}`, row);
            }

            const inserts: Array<[string, string, string, string, string]> = [];
            const updates: Array<{ stmt: ReturnType<typeof c.env.DB.prepare>; params: unknown[] }> = [];

            for (const p of nonSelfPosts) {
              const key = `${p.user_id}:${p.id}`;
              const existing = existingMap.get(key);

              if (existing) {
                const actorData = existing.actor_data
                  ? JSON.parse(existing.actor_data as string)
                  : existing.actor_id
                    ? [existing.actor_id as string]
                    : [];
                if (!actorData.includes(userId)) {
                  actorData.push(userId);
                }
                updates.push({
                  stmt: c.env.DB.prepare(
                    "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
                  ),
                  params: [actorData[0], JSON.stringify(actorData), existing.id as string],
                });
              } else {
                inserts.push([nanoid(), String(p.user_id), 'fresh', String(p.id), userId]);
              }
            }

            // Batch all notification updates and inserts
            const batchStmts: Array<ReturnType<typeof c.env.DB.prepare>> = [];
            for (const update of updates) {
              batchStmts.push(update.stmt.bind(...update.params));
            }
            if (inserts.length > 0) {
              for (const row of inserts) {
                batchStmts.push(
                  c.env.DB.prepare(
                    'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
                  ).bind(...row),
                );
              }
            }
            if (batchStmts.length > 0) {
              await c.env.DB.batch(batchStmts);
            }
          } catch (e) {
            console.error('Failed to create batch fresh notifications:', e);
          }
        }
      }

      return c.json({ freshed: toFresh, already_freshed: Array.from(alreadyFreshed) });
    } else {
      // Remove freshes
      await c.env.DB.prepare(`
        DELETE FROM freshs WHERE user_id = ? AND post_id IN (${post_ids.map(() => '?').join(',')})
      `)
        .bind(userId, ...post_ids)
        .run();

      // Batch update fresh counts
      await c.env.DB.prepare(`
        UPDATE posts SET fresh_count = fresh_count - 1, engagement_hotness = engagement_hotness - 2.0 WHERE id IN (${post_ids.map(() => '?').join(',')})
      `)
        .bind(...post_ids)
        .run();

      return c.json({ unfreshed: post_ids });
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Batch fresh error:', error);
    return c.json({ error: 'Batch fresh operation failed', details: err.message }, 500);
  }
});

// POST /api/posts/:id/share - toggle share/repost (protected)
posts.post('/posts/:id/share', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id');
    const currentUser = c.get('user');
    if (!currentUser) return c.json({ error: 'Unauthorized' }, 401);

    // Get post info
    const post = (await c.env.DB.prepare(
      "SELECT id, user_id, actor_id, username FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first()) as { id: string; user_id: string; actor_id: string | null; username: string } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    // Check if already shared
    const existing = await c.env.DB.prepare('SELECT id FROM shares WHERE post_id = ? AND user_id = ?')
      .bind(postId, currentUser.id)
      .first();

    if (existing) {
      // Remove share
      await c.env.DB.prepare('DELETE FROM shares WHERE post_id = ? AND user_id = ?').bind(postId, currentUser.id).run();

      await c.env.DB.prepare(
        'UPDATE posts SET reply_count = MAX(0, reply_count - 1), engagement_hotness = MAX(0.0, engagement_hotness - 3.0) WHERE id = ?',
      )
        .bind(postId)
        .run();

      return c.json({ shared: false });
    } else {
      // Add share
      const shareId = nanoid();
      await c.env.DB.prepare(
        "INSERT INTO shares (id, post_id, user_id, actor_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
        .bind(shareId, postId, currentUser.id, `${c.env.BASE_URL}/actors/${currentUser.username}`)
        .run();

      await c.env.DB.prepare(
        'UPDATE posts SET reply_count = reply_count + 1, engagement_hotness = engagement_hotness + 3.0 WHERE id = ?',
      )
        .bind(postId)
        .run();

      // Send Announce for remote posts
      if (post.actor_id && c.env.AP_DELIVERY_QUEUE) {
        try {
          const actorResponse = await fetch(post.actor_id, {
            headers: { Accept: 'application/activity+json, application/ld+json' },
          });
          if (actorResponse.ok) {
            const actorData = (await actorResponse.json()) as ActorData;
            const inboxUrl = actorData.inbox;
            if (inboxUrl) {
              const announceActivity = {
                '@context': 'https://www.w3.org/ns/activitystreams',
                id: `${c.env.BASE_URL}/activities/announce-${shareId}`,
                type: 'Announce',
                actor: `${c.env.BASE_URL}/actors/${currentUser.username}`,
                object: `${c.env.BASE_URL}/notes/${postId}`,
                to: [post.actor_id, 'https://www.w3.org/ns/activitystreams#Public'],
              };
              await c.env.AP_DELIVERY_QUEUE.send({
                type: 'delivery',
                inboxUrl,
                activity: announceActivity,
                senderUsername: currentUser.username,
              });
            }
          }
        } catch (e) {
          console.error('Failed to send Announce activity:', e);
        }
      }

      return c.json({ shared: true, share_id: shareId });
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Share error:', error);
    return c.json({ error: 'Share operation failed', details: err.message }, 500);
  }
});

// GET /api/posts/:id/replies - get direct replies
posts.get('/posts/:id/replies', async (c) => {
  try {
    const postId = c.req.param('id');
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);

    // Get current user ID from session (optional)
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    const currentUserId = sessionData?.user?.id || null;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Verify parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first();

    if (!parentPost) {
      return c.json({ error: 'Post not found' }, 404);
    }

    let query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.badge_type, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.parent_id = ? AND p.status = 'published' 
       ORDER BY p.created_at ASC LIMIT ?`;
    const params: Array<unknown> = [postId, limit];

    if (cursor) {
      query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.badge_type, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.parent_id = ? AND p.status = 'published' AND p.created_at < ?
       ORDER BY p.created_at ASC LIMIT ?`;
      params.splice(1, 0, cursor);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!result.success) {
      return c.json({ error: 'Failed to fetch replies' }, 500);
    }

    const replies = result.results || [];
    const _nextCursor = replies.length === limit ? replies[replies.length - 1].created_at : null;

    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    // Add poll data
    await enrichPostsWithPolls([parentPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithQuotes([parentPost as PostRow], c.env.DB);
    await enrichPostsWithAttachments([parentPost as PostRow], c.env.DB);
    await enrichPostsWithReactions([parentPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    // Trigger vector embedding for unprocessed posts in background
    const allPosts = [parentPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)];
    const toEmbed = allPosts.filter((p) => p.text);
    if (toEmbed.length > 0) {
      const existingRows = await c.env.DB.prepare(
        `SELECT post_id FROM post_embeddings WHERE post_id IN (${toEmbed.map(() => '?').join(',')})`,
      )
        .bind(...toEmbed.map((p) => p.id as string))
        .all<{ post_id: string }>();
      const existingIds = new Set((existingRows.results || []).map((r) => r.post_id));
      for (const p of toEmbed) {
        if (!existingIds.has(p.id as string)) {
          embedPost(c.env.DB, c.env, p.id as string, p.text as string).catch((e) =>
            console.error('Background embed failed:', e),
          );
        }
      }
    }

    return c.json({ root: parentPost, replies });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Thread fetch error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/posts/:id/thread - get full thread
posts.get('/posts/:id/thread', async (c) => {
  try {
    const postId = c.req.param('id');

    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    const currentUserId = sessionData?.user?.id || null;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first();

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const rootId = (post as Record<string, unknown>).root_id || (post as Record<string, unknown>).id;

    const rootPost = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.badge_type, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.id = ? AND p.status = 'published'`,
    )
      .bind(rootId)
      .first();

    if (!rootPost) {
      return c.json({ error: 'Thread not found' }, 404);
    }

    const repliesResult = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.badge_type, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.root_id = ? AND p.status = 'published' AND p.id != ?
       ORDER BY p.created_at ASC LIMIT 200`,
    )
      .bind(rootId, rootId)
      .all();

    if (!repliesResult.success) {
      return c.json({ error: 'Failed to fetch thread' }, 500);
    }

    const replies = repliesResult.results || [];

    if (currentUserId) {
      const allPosts: Array<Record<string, unknown>> = [
        rootPost as Record<string, unknown>,
        ...(replies as Array<Record<string, unknown>>),
      ];
      const postIds = allPosts.map((p: Record<string, unknown>) => p.id as string);

      const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
      (rootPost as Record<string, unknown>).is_freshed = freshed.has(
        (rootPost as Record<string, unknown>).id as string,
      );
      (replies as Array<Record<string, unknown>>).forEach((post: Record<string, unknown>) => {
        post.is_freshed = freshed.has(post.id as string);
      });
      (rootPost as Record<string, unknown>).is_bookmarked = bookmarked.has(
        (rootPost as Record<string, unknown>).id as string,
      );
      (replies as Array<Record<string, unknown>>).forEach((post: Record<string, unknown>) => {
        post.is_bookmarked = bookmarked.has(post.id as string);
      });
    }

    await enrichPostsWithPolls([rootPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithQuotes([rootPost as PostRow], c.env.DB);
    await enrichPostsWithAttachments([rootPost as PostRow], c.env.DB);
    await enrichPostsWithReactions([rootPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    const allPosts2 = [rootPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)];
    const toEmbed2 = allPosts2.filter((p) => p.text);
    if (toEmbed2.length > 0) {
      const existingRows2 = await c.env.DB.prepare(
        `SELECT post_id FROM post_embeddings WHERE post_id IN (${toEmbed2.map(() => '?').join(',')})`,
      )
        .bind(...toEmbed2.map((p) => p.id as string))
        .all<{ post_id: string }>();
      const existingIds2 = new Set((existingRows2.results || []).map((r) => r.post_id));
      for (const p of toEmbed2) {
        if (!existingIds2.has(p.id as string)) {
          embedPost(c.env.DB, c.env, p.id as string, p.text as string).catch((e) =>
            console.error('Background embed failed:', e),
          );
        }
      }
    }

    return c.json({ root: rootPost, replies });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Thread fetch error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// Step 1 — POST /api/posts/:id/replies/prepare (protected)
posts.post('/posts/:id/replies/prepare', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id');
    const { filename, contentType } = await c.req.json();

    if (!filename || !contentType) {
      return c.json({ error: 'Missing filename or contentType' }, 400);
    }

    const allowedTypes = [
      'image/gif',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/mp4',
      'audio/webm',
    ];
    if (!allowedTypes.includes(contentType)) {
      return c.json(
        { error: 'Only image files (GIF, PNG, JPG) and audio files (MP3, WAV, OGG, M4A, WebM) are supported' },
        400,
      );
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first();

    if (!parentPost) {
      return c.json({ error: 'Parent post not found' }, 404);
    }

    const replyId = crypto.randomUUID();
    let fileExtension: string;
    let storageKey: string;

    if (contentType.startsWith('image/')) {
      fileExtension =
        contentType === 'image/png'
          ? '.png'
          : contentType === 'image/jpeg' || contentType === 'image/jpg'
            ? '.jpg'
            : '.gif';
      storageKey = `gif/${replyId}${fileExtension}`;
    } else if (contentType.startsWith('audio/')) {
      fileExtension =
        contentType === 'audio/mpeg'
          ? '.mp3'
          : contentType === 'audio/wav'
            ? '.wav'
            : contentType === 'audio/ogg'
              ? '.ogg'
              : contentType === 'audio/mp4'
                ? '.m4a'
                : '.webm';
      storageKey = `audio/${replyId}${fileExtension}`;
    } else {
      return c.json({ error: 'Unsupported file type' }, 400);
    }

    const gifKey = storageKey;

    // Compute depth and root_id
    const depth = Math.min(Number(parentPost.depth || 0) + 1, 5);
    const rootId = parentPost.root_id || parentPost.id;

    // Store pending reply in D1
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, engagement_hotness, status, parent_id, root_id, depth, reply_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'pending', ?, ?, ?, 0)
    `)
      .bind(
        replyId,
        c.get('user')?.id || '',
        c.get('user')?.username || 'anonymous',
        '',
        '[]',
        '[]',
        gifKey,
        '',
        '',
        postId,
        rootId,
        depth,
      )
      .run();

    if (!result.success) {
      return c.json({ error: 'Failed to create pending reply' }, 500);
    }

    // Generate upload endpoint URL (our own API)
    const gifUploadUrl = `${new URL(c.req.url).origin}/api/upload/${gifKey}`;

    return c.json({
      replyId,
      gifUploadUrl,
      gifKey,
    });
  } catch (error: unknown) {
    console.error('Prepare reply error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Step 3 — POST /api/posts/:id/replies/commit (protected)
posts.post('/posts/:id/replies/commit', requireAuth, async (c) => {
  const postId = c.req.param('id');

  try {
    const { replyId, gifKey, text, hashtags } = await c.req.json();

    // Validate text
    if (!text || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422);
    }

    // Validate hashtags
    if (!Array.isArray(hashtags) || hashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422);
    }

    for (const tag of hashtags) {
      if (
        typeof tag !== 'string' ||
        tag.length > 20 ||
        !/^[a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(tag)
      ) {
        return c.json({ error: 'Hashtags must be alphanumeric, Japanese characters, and ≤20 chars' }, 422);
      }
    }

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
    const mentionSet = new Set<string>();
    let mentionMatch: RegExpExecArray | null;
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1]);
    }
    const mentionedUsernames = Array.from(mentionSet);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate parent still exists and is published
    const parentPost = (await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      username: string;
      text: string;
      depth: number;
      root_id: string | null;
    } | null;

    if (!parentPost) {
      return c.json({ error: 'Parent post no longer available' }, 422);
    }

    let reply: Record<string, unknown> | undefined;
    let mentionsJson: string | null = '[]';

    if (gifKey) {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous';
      mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, replyUsername);

      // Validate that this is a pending reply and gifKey matches
      const pendingReply = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ? AND status = 'pending' AND gif_key = ? AND parent_id = ?
      `)
        .bind(replyId, gifKey, postId)
        .first();

      if (!pendingReply) {
        return c.json({ error: 'Invalid or expired reply preparation' }, 422);
      }

      // Check if GIF exists in R2 (simplified check for now)
      const gifExists = true; // Placeholder - implement actual R2 check

      if (!gifExists) {
        return c.json({ error: 'GIF not uploaded' }, 422);
      }

      // Update reply to published status
      const updateResult = await c.env.DB.prepare(`
        UPDATE posts 
        SET text = ?, hashtags = ?, mentions = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `)
        .bind(text, JSON.stringify(hashtags), mentionsJson, replyId)
        .run();

      if (!updateResult.success) {
        return c.json({ error: 'Failed to commit reply' }, 500);
      }

      // Return the updated reply
      reply =
        (await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.hidden, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
      `)
          .bind(replyId)
          .first()) ?? undefined;
    } else {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous';
      mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, replyUsername);

      // Create text-only reply directly
      const depth = Math.min(Number(parentPost.depth || 0) + 1, 5);
      const rootId = parentPost.root_id || parentPost.id;

      try {
        const result = await c.env.DB.prepare(`
          INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, engagement_hotness, status, parent_id, root_id, depth, reply_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'published', ?, ?, ?, 0)
        `)
          .bind(
            replyId,
            c.get('user')?.id || '',
            replyUsername,
            text,
            JSON.stringify(hashtags),
            mentionsJson,
            '',
            '',
            '',
            postId,
            rootId,
            depth,
          )
          .run();

        if (!result.success) {
          console.error('Failed to create reply:', result.error);
          return c.json({ error: 'Failed to create reply' }, 500);
        }

        // Return the created reply
        reply =
          (await c.env.DB.prepare(`
          SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.hidden, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
        `)
            .bind(replyId)
            .first()) ?? undefined;
      } catch (dbError: unknown) {
        const err = dbError as { message?: string; stack?: string; cause?: unknown; name?: string };
        console.error('Database error creating reply:', dbError);
        console.error('Error details:', {
          message: err.message,
          stack: err.stack,
          cause: err.cause,
          name: err.name,
        });
        return c.json({ error: 'Database error', details: err.message || 'Unknown error' }, 500);
      }
    }

    // Increment parent's reply count and engagement hotness
    const incrementResult = await c.env.DB.prepare(`
      UPDATE posts SET reply_count = COALESCE(reply_count, 0) + 1, engagement_hotness = COALESCE(engagement_hotness, 1.0) + 3.0 WHERE id = ?
    `)
      .bind(postId)
      .run();

    if (!incrementResult.success) {
      console.error('Failed to increment reply count for post:', postId);
      // Don't fail the whole operation, just log the error
    }

    // Create notification for the parent post author (if not replying to own post)
    const notifiedUserIds = new Set<string>();
    const replyUserId = c.get('user')?.id || '';
    if (parentPost.user_id !== replyUserId) {
      try {
        // Group reply notifications: check for existing reply notification for this post
        const existingNotif = (await c.env.DB.prepare(
          "SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = 'reply' ORDER BY created_at DESC LIMIT 1",
        )
          .bind(parentPost.user_id, postId)
          .first()) as Record<string, unknown>;

        if (existingNotif) {
          const actorData = existingNotif.actor_data
            ? JSON.parse(existingNotif.actor_data as string)
            : existingNotif.actor_id
              ? [existingNotif.actor_id as string]
              : [];
          if (!actorData.includes(replyUserId)) {
            actorData.push(replyUserId);
          }
          await c.env.DB.prepare(
            "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
          )
            .bind(actorData[0], JSON.stringify(actorData), existingNotif.id as string)
            .run();
        } else {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          )
            .bind(nanoid(), parentPost.user_id, 'reply', postId, replyUserId)
            .run();
          // Send push notification to parent post author
          {
            const actor = c.get('user');

            await sendPushToAll(c.env, parentPost.user_id, 'reply', actor?.username, actor?.display_name, text, postId);
          }
        }
        notifiedUserIds.add(parentPost.user_id);
      } catch (e) {
        console.error('Failed to create reply notification:', e);
        // Don't fail the whole operation, just log the error
      }
    }

    // Create mention notifications for mentioned users in the reply
    // (skip self-mentions, users already notified for this reply, and duplicates)
    if (mentionedUsernames.length > 0) {
      try {
        const mentionData = JSON.parse(mentionsJson) as Array<{ username: string; user_id: string }>;
        const mentionTargets = mentionData.filter((m) => {
          if (m.user_id === replyUserId) return false;
          if (notifiedUserIds.has(m.user_id)) return false;
          notifiedUserIds.add(m.user_id);
          return true;
        });
        const mentionStmts = mentionTargets.map((m) =>
          c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          ).bind(nanoid(), m.user_id, 'mention', replyId, replyUserId),
        );
        if (mentionStmts.length > 0) {
          await c.env.DB.batch(mentionStmts);
        }
        const actor = c.get('user');
        for (const mention of mentionTargets) {
          await sendPushToAll(c.env, mention.user_id, 'mention', actor?.username, actor?.display_name, text, postId);
        }
      } catch (e) {
        // Don't fail the reply creation if mention notifications fail
        console.error('Failed to create mention notifications:', e);
      }
    }

    // Create notifications for >>N post references in the reply
    // Skip if the referenced post author was already notified (e.g., parent post author)
    try {
      const refRegex = />>(\d+)/g;
      const referencedIndices = new Set<number>();
      let refMatch: RegExpExecArray | null;
      while ((refMatch = refRegex.exec(text)) !== null) {
        const index = parseInt(refMatch[1], 10);
        if (index > 0) referencedIndices.add(index);
      }

      if (referencedIndices.size > 0) {
        const rootId = parentPost.root_id || parentPost.id;
        const allRepliesResult = await c.env.DB.prepare(
          "SELECT id, user_id, username FROM posts WHERE root_id = ? AND status = 'published' AND id != ? ORDER BY created_at ASC",
        )
          .bind(rootId, rootId)
          .all();

        const allReplies = allRepliesResult.results || [];

        const refUpdateStmts: D1PreparedStatement[] = [];
        const refNotifyStmts: D1PreparedStatement[] = [];
        const refNotifyTargets: Array<{ userId: string; user_id: string }> = [];
        for (const refIndex of referencedIndices) {
          const arrayIndex = refIndex - 1;
          if (arrayIndex >= 0 && arrayIndex < allReplies.length) {
            const referencedPost = allReplies[arrayIndex] as Record<string, unknown>;
            if (referencedPost.id !== postId) {
              refUpdateStmts.push(
                c.env.DB.prepare(
                  'UPDATE posts SET reply_count = COALESCE(reply_count, 0) + 1, engagement_hotness = COALESCE(engagement_hotness, 1.0) + 3.0 WHERE id = ?',
                ).bind(referencedPost.id as string),
              );
            }
            if (
              referencedPost.user_id &&
              (referencedPost.user_id as string) !== replyUserId &&
              !notifiedUserIds.has(referencedPost.user_id as string)
            ) {
              refNotifyStmts.push(
                c.env.DB.prepare(
                  'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
                ).bind(nanoid(), referencedPost.user_id as string, 'reply', replyId, replyUserId),
              );
              refNotifyTargets.push({
                userId: referencedPost.user_id as string,
                user_id: referencedPost.user_id as string,
              });
            }
          }
        }
        const allRefStmts = [...refUpdateStmts, ...refNotifyStmts];
        if (allRefStmts.length > 0) {
          await c.env.DB.batch(allRefStmts);
        }
        for (const target of refNotifyTargets) {
          const actor = c.get('user');
          await sendPushToAll(c.env, target.userId, 'reply', actor?.username, actor?.display_name, text || '', replyId);
        }
      }
    } catch (e) {
      console.error('Failed to create >>N reference notifications:', e);
    }

    if (gifKey) {
      screenPostImages(c.env.DB, c.env, replyId, [gifKey]).catch((e) =>
        console.error('Background NSFW screen failed:', e),
      );
    }

    return c.json({ reply });
  } catch (error: unknown) {
    const err = error as { message?: string; stack?: string; cause?: unknown; name?: string; replyId?: string };
    console.error('Commit reply error:', error);
    console.error('Full error details:', {
      message: err.message,
      stack: err.stack,
      cause: err.cause,
      name: err.name,
      postId: postId || 'unknown',
      replyId: err.replyId || 'unknown',
    });
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/search - search posts and users
posts.get('/search', async (c) => {
  try {
    const query = c.req.query('q');
    const type = c.req.query('type') || 'posts';
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);

    if (!query || query.trim().length === 0) {
      return c.json({ error: 'Search query required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Try cache hit
    const cacheKey = makeCacheKey('search', c, `${type}:${limit}:${query.trim().toLowerCase().slice(0, 100)}`);
    const cached = await kvCacheGet<{
      type: string;
      query: string;
      results: Record<string, unknown>[];
      users: Record<string, unknown>[];
    }>(c, cacheKey);
    if (cached) {
      return c.json(cached);
    }

    const tokens = query.trim().split(/\s+/).filter(Boolean);

    if (type === 'users') {
      const cleanQuery = query.trim().replace(/^@/, '');
      const searchTerm = `%${cleanQuery}%`;
      const users = await c.env.DB.prepare(`
        SELECT id, username, display_name, bio, avatar_key, badge_type, created_at
        FROM users
        WHERE username LIKE ? OR display_name LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
        .bind(searchTerm, searchTerm, limit)
        .all();

      return c.json({
        type: 'users',
        query,
        results: users.results || [],
      });
    }

    // Build multi-term AND search for posts / arcade
    const conditions: string[] = [];
    const params: Array<unknown> = [];

    if (type === 'arcade') {
      conditions.push("(p.payload_key IS NOT NULL AND p.payload_key != '' AND (p.swf_key IS NULL OR p.swf_key = ''))");
    }

    for (const token of tokens) {
      if (token.startsWith('#')) {
        const tag = token.slice(1).trim();
        if (tag) {
          conditions.push(`EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?)`);
          params.push(tag);
        }
      } else {
        conditions.push('LOWER(p.text) LIKE ?');
        params.push(`%${token.toLowerCase()}%`);
      }
    }

    const cleanQuery = query.trim().replace(/^@/, '');
    const searchTerm = `%${cleanQuery.toLowerCase()}%`;

    let usersResult: Array<Record<string, unknown>> = [];

    if (conditions.length === 0) {
      // No specific tokens, but still search users by the raw query
      if (type === 'posts') {
        const users = await c.env.DB.prepare(`
          SELECT username, display_name, avatar_key, badge_type
          FROM users
          WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
          ORDER BY created_at DESC LIMIT ?
        `)
          .bind(searchTerm, searchTerm, limit)
          .all();
        usersResult = (users.results || []).map((u: Record<string, unknown>) => ({
          username: u.username,
          display_name: u.display_name || '',
          avatar_key: u.avatar_key || '',
          badge_type: (u.badge_type as string | null) ?? null,
        }));
      }
      return c.json({ type, query, results: [], users: usersResult });
    }

    const whereClause = `WHERE p.status = 'published' AND p.hidden = 0 AND (${conditions.join(' AND ')})`;

    const selectColumns = `
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
    `;

    const posts = await c.env.DB.prepare(`${selectColumns} ${whereClause} ORDER BY p.created_at DESC LIMIT ?`)
      .bind(...params, limit)
      .all();

    await enrichPostsWithQuotes((posts.results || []) as PostRow[], c.env.DB);
    await enrichPostsWithAttachments((posts.results || []) as PostRow[], c.env.DB);
    await enrichPostsWithReactions((posts.results || []) as PostRow[], c.env.DB, c.get('user')?.id);

    // Also fetch matching users for posts search (type=posts)
    if (type === 'posts') {
      const users = await c.env.DB.prepare(`
        SELECT username, display_name, avatar_key, badge_type
        FROM users
        WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
        ORDER BY created_at DESC LIMIT ?
      `)
        .bind(searchTerm, searchTerm, limit)
        .all();
      usersResult = (users.results || []).map((u: Record<string, unknown>) => ({
        username: u.username,
        display_name: u.display_name || '',
        avatar_key: u.avatar_key || '',
        badge_type: (u.badge_type as string | null) ?? null,
      }));
    }

    const responseData = {
      type,
      query,
      results: posts.results || [],
      users: usersResult,
    };
    await kvCacheSet(c, cacheKey, responseData, 30);
    return c.json(responseData);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Search error:', error);
    return c.json({ error: 'Search failed', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/posts/:id - delete post (protected)
posts.delete('/posts/:id', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id');
    const userId = c.get('user')?.id || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get the post to verify ownership and get file keys
    const post = (await c.env.DB.prepare(
      'SELECT id, user_id, username, parent_id, gif_key, payload_key, swf_key, thumbnail_key, status FROM posts WHERE id = ?',
    )
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      username: string;
      parent_id?: string;
      gif_key?: string;
      payload_key?: string;
      swf_key?: string;
      thumbnail_key?: string;
      status?: string;
    } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    // Verify ownership
    if (post.user_id !== userId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Delete associated files from R2
    if (c.env.BUCKET) {
      for (const key of await collectAttachmentKeys(c.env.DB, [post.id])) {
        try {
          await c.env.BUCKET.delete(key);
        } catch (e) {
          console.error('Failed to delete attachment file:', e);
        }
      }
      if (post.gif_key) {
        try {
          await c.env.BUCKET.delete(post.gif_key);
        } catch (e) {
          console.error('Failed to delete gif file:', e);
        }
      }
      if (post.payload_key) {
        try {
          await c.env.BUCKET.delete(post.payload_key);
        } catch (e) {
          console.error('Failed to delete payload file:', e);
        }
      }
      if (post.swf_key) {
        try {
          await c.env.BUCKET.delete(post.swf_key);
        } catch (e) {
          console.error('Failed to delete SWF file:', e);
        }
      }
      if (post.thumbnail_key) {
        try {
          await c.env.BUCKET.delete(post.thumbnail_key);
        } catch (e) {
          console.error('Failed to delete thumbnail file:', e);
        }
      }
    }

    // Delete all replies (and their replies) to this post using recursive CTE
    const descendantResult = await c.env.DB.prepare(`
      WITH RECURSIVE tree AS (
        SELECT id, gif_key, payload_key, swf_key, thumbnail_key FROM posts WHERE parent_id = ?
        UNION ALL
        SELECT p.id, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key FROM posts p INNER JOIN tree t ON p.parent_id = t.id
      )
      SELECT id, gif_key, payload_key, swf_key, thumbnail_key FROM tree
    `)
      .bind(postId)
      .all<{
        id: string;
        gif_key: string | null;
        payload_key: string | null;
        swf_key: string | null;
        thumbnail_key: string | null;
      }>();
    const descendants = descendantResult.results || [];

    // Delete descendant reply files from R2
    if (c.env.BUCKET) {
      for (const key of await collectAttachmentKeys(
        c.env.DB,
        descendants.map((r) => r.id),
      )) {
        try {
          await c.env.BUCKET.delete(key);
        } catch (e) {
          console.error('Failed to delete descendant attachment file:', e);
        }
      }
      for (const desc of descendants) {
        if (desc.gif_key) {
          try {
            await c.env.BUCKET.delete(desc.gif_key);
          } catch (e) {
            console.error('Failed to delete descendant gif file:', e);
          }
        }
        if (desc.payload_key) {
          try {
            await c.env.BUCKET.delete(desc.payload_key);
          } catch (e) {
            console.error('Failed to delete descendant payload file:', e);
          }
        }
        if (desc.swf_key) {
          try {
            await c.env.BUCKET.delete(desc.swf_key);
          } catch (e) {
            console.error('Failed to delete descendant SWF file:', e);
          }
        }
        if (desc.thumbnail_key) {
          try {
            await c.env.BUCKET.delete(desc.thumbnail_key);
          } catch (e) {
            console.error('Failed to delete descendant thumbnail file:', e);
          }
        }
      }
    }

    const descendantIds = descendants.map((r) => r.id);
    if (descendantIds.length > 0) {
      const placeholders = descendantIds.map(() => '?').join(',');
      await c.env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`)
        .bind(...descendantIds)
        .run();
    }

    await deleteAttachmentRows(c.env.DB, [post.id, ...descendantIds]);

    // Delete the post
    const result = await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();

    if (!result.success) {
      return c.json({ error: 'Failed to delete post' }, 500);
    }

    // Decrement parent's reply count and engagement hotness if this post was a reply
    if (post.parent_id) {
      await c.env.DB.prepare(
        'UPDATE posts SET reply_count = COALESCE(reply_count, 0) - 1, engagement_hotness = GREATEST(COALESCE(engagement_hotness, 1.0) - 3.0, 0.0) WHERE id = ?',
      )
        .bind(post.parent_id)
        .run();
    }

    // Queue ActivityPub delete delivery for public posts
    if (post && post.status === 'published') {
      try {
        const user = c.get('user');
        if (user) {
          const noteId = `${c.env.BASE_URL}/notes/${postId}`;
          const activity = buildDeleteActivity(noteId, user, c.env.BASE_URL);

          // Get all followers to deliver to
          const followers = await c.env.DB.prepare(`
            SELECT inbox_url FROM ap_followers WHERE local_user_id = ?
          `)
            .bind(user.id)
            .all();

          // Queue delivery to each follower
          for (const follower of followers.results) {
            const inboxUrl = follower.inbox_url;
            if (inboxUrl) {
              await c.env.AP_DELIVERY_QUEUE.send({
                type: 'delivery',
                inboxUrl,
                activity,
                senderUsername: user.username,
              });
            }
          }
        }
      } catch (deliveryError) {
        console.error('Failed to queue ActivityPub delete delivery:', deliveryError);
        // Don't fail the post deletion if delivery queuing fails
      }
    }

    // Invalidate cache entries related to the deleted post
    if (c.env.CACHE) {
      try {
        // Delete games cache entries (since deleted posts might be games)
        await c.env.CACHE.delete('games:recent:20:first');
        await c.env.CACHE.delete('games:trending:20:first');

        // Delete any other cache keys that might contain this post
        // Pattern: games:{trending|recent}:{limit}:{cursor}
        // We'll delete the most common ones
        const cacheKeysToDelete = [
          'games:recent:20:first',
          'games:trending:20:first',
          'games:recent:50:first',
          'games:trending:50:first',
        ];

        for (const key of cacheKeysToDelete) {
          await c.env.CACHE.delete(key);
        }

        console.log('Cache invalidated for deleted post:', postId);
      } catch (cacheError) {
        console.warn('Failed to invalidate cache for deleted post:', cacheError);
        // Don't fail the deletion if cache invalidation fails
      }
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Delete post error:', error);
    return c.json({ error: 'Failed to delete post', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/posts/:id - edit post (protected)
posts.put('/posts/:id', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const userId = user.id;
    const postId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, mentions, status, gif_key, payload_key, swf_key, thumbnail_key, edited_at FROM posts WHERE id = ?',
    )
      .bind(postId)
      .first<{
        id: string;
        user_id: string;
        username: string;
        text: string;
        hashtags: string | null;
        mentions: string | null;
        status: string;
        gif_key: string | null;
        payload_key: string | null;
        swf_key: string | null;
        thumbnail_key: string | null;
        edited_at: string | null;
      } | null>();

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    if (post.user_id !== userId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (post.status !== 'published') {
      return c.json({ error: 'Cannot edit this post' }, 400);
    }

    const body = (await c.req.json()) as {
      text?: string;
      gif_key?: string | null;
      payload_key?: string | null;
      swf_key?: string | null;
      thumbnail_key?: string | null;
      attachments?: AttachmentInput[];
    };

    const now = new Date().toISOString();
    let trimmed = post.text;
    let hashtagsJson = post.hashtags;
    let mentionsJson = post.mentions;
    let textChanged = false;

    // Update text if provided
    if (body.text !== undefined && typeof body.text === 'string') {
      trimmed = body.text.trim();
      if (trimmed.length < 1 || trimmed.length > 200) {
        return c.json({ error: 'Text must be between 1 and 200 characters' }, 422);
      }
      textChanged = true;

      // Extract hashtags from text
      const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
      const hashtagSet = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = hashtagRegex.exec(trimmed)) !== null) {
        hashtagSet.add(match[1]);
      }
      const hashtags = Array.from(hashtagSet);
      if (hashtags.length > 5) {
        return c.json({ error: 'Maximum 5 hashtags allowed' }, 422);
      }
      hashtagsJson = JSON.stringify(hashtags);

      // Extract mentions from text
      const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
      const mentionSet = new Set<string>();
      let mentionMatch: RegExpExecArray | null;
      while ((mentionMatch = mentionRegex.exec(trimmed)) !== null) {
        mentionSet.add(mentionMatch[1]);
      }
      const mentionedUsernames = Array.from(mentionSet);
      mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, post.username);
    }

    // Handle attachment key updates and cleanup old files
    const updatedGifKey = body.gif_key !== undefined ? body.gif_key : post.gif_key;
    const updatedPayloadKey = body.payload_key !== undefined ? body.payload_key : post.payload_key;
    const updatedSwfKey = body.swf_key !== undefined ? body.swf_key : post.swf_key;
    const updatedThumbnailKey = body.thumbnail_key !== undefined ? body.thumbnail_key : post.thumbnail_key;

    // Delete old files from R2 when keys change
    const keysToDelete: string[] = [];
    if (body.gif_key !== undefined && post.gif_key && post.gif_key !== body.gif_key) {
      keysToDelete.push(post.gif_key);
    }
    if (body.payload_key !== undefined && post.payload_key && post.payload_key !== body.payload_key) {
      keysToDelete.push(post.payload_key);
    }
    if (body.swf_key !== undefined && post.swf_key && post.swf_key !== body.swf_key) {
      keysToDelete.push(post.swf_key);
    }
    if (body.thumbnail_key !== undefined && post.thumbnail_key && post.thumbnail_key !== body.thumbnail_key) {
      keysToDelete.push(post.thumbnail_key);
    }

    if (keysToDelete.length > 0 && c.env.BUCKET) {
      Promise.all(keysToDelete.map((k) => c.env.BUCKET.delete(k).catch(() => {}))).catch(() => {});
    }

    // Handle multi-media attachments (full list replacement; [] clears them)
    let attachmentsChanged = false;
    let newAttachments: AttachmentRecord[] = [];
    if (body.attachments !== undefined) {
      // A non-array (e.g. `{}`) has no usable length, so it would otherwise
      // slip past validation below and wipe every attachment with a 200.
      if (!Array.isArray(body.attachments)) {
        return c.json({ error: 'attachments must be an array' }, 422);
      }
      // Existing rows also bound the list: a subscription that lapsed must
      // still be able to keep or shrink an over-limit attachment set. Only
      // growth beyond the current plan is rejected.
      const existingRows =
        (
          await c.env.DB.prepare('SELECT r2_key FROM post_attachments WHERE post_id = ? ORDER BY position')
            .bind(postId)
            .all<{ r2_key: string }>()
        ).results || [];
      const existingKeys = existingRows.map((r) => r.r2_key);

      if (body.attachments.length > 0) {
        const planLimit = await resolveAttachmentLimit(c.env, post.user_id);
        const attachmentError = validateAttachmentInputs(body.attachments, Math.max(planLimit, existingKeys.length));
        if (attachmentError) return c.json({ error: attachmentError }, 422);
        newAttachments = sequenceAttachments(body.attachments);
        if (updatedGifKey || updatedPayloadKey || updatedSwfKey || updatedThumbnailKey) {
          return c.json({ error: 'Cannot combine attachments with legacy media keys' }, 422);
        }
        for (const att of newAttachments) {
          if (parseAttachmentKey(att.r2_key)?.postId !== postId) {
            return c.json({ error: 'Attachment does not belong to this post' }, 422);
          }
        }
        const sizeCheck = await sumAttachmentSizes(
          c.env.BUCKET,
          newAttachments.map((a) => a.r2_key),
        );
        if (sizeCheck.error) return c.json({ error: sizeCheck.error }, 413);
      }

      const nextKeys = newAttachments.map((a) => a.r2_key);
      attachmentsChanged = existingKeys.length !== nextKeys.length || existingKeys.some((k, i) => k !== nextKeys[i]);

      if (attachmentsChanged) {
        const nextKeySet = new Set(nextKeys);
        const removed = existingKeys.filter((k) => !nextKeySet.has(k));
        if (removed.length > 0 && c.env.BUCKET) {
          // Awaited: prepare-media probes R2 for a free slot, and a deferred
          // delete could make it skip the slot this edit just freed.
          await Promise.all(removed.map((k) => c.env.BUCKET.delete(k).catch(() => {})));
        }
        // One batch = one implicit transaction, so a failed insert cannot
        // leave the post with no attachments after the DELETE.
        const statements = [c.env.DB.prepare('DELETE FROM post_attachments WHERE post_id = ?').bind(postId)];
        for (const att of newAttachments) {
          statements.push(
            c.env.DB.prepare('INSERT INTO post_attachments (post_id, r2_key, kind, position) VALUES (?, ?, ?, ?)').bind(
              postId,
              att.r2_key,
              att.kind,
              att.position,
            ),
          );
        }
        await c.env.DB.batch(statements);
      }
    }

    await c.env.DB.prepare(
      'UPDATE posts SET text = ?, hashtags = ?, mentions = ?, gif_key = ?, payload_key = ?, swf_key = ?, thumbnail_key = ?, edited_at = ? WHERE id = ?',
    )
      .bind(
        trimmed,
        hashtagsJson || '[]',
        mentionsJson || '[]',
        updatedGifKey || null,
        updatedPayloadKey || null,
        updatedSwfKey || null,
        updatedThumbnailKey || null,
        textChanged || keysToDelete.length > 0 || attachmentsChanged ? now : post.edited_at || null,
        postId,
      )
      .run();

    // Fetch updated post
    const updated = (await c.env.DB.prepare(
      "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key as payloadKey, p.swf_key as swfKey, p.thumbnail_key as thumbnailKey, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.edited_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?",
    )
      .bind(postId)
      .first()) as Record<string, unknown> | null;

    await enrichPostsWithQuotes([updated as PostRow], c.env.DB);
    await enrichPostsWithAttachments([updated as PostRow], c.env.DB);

    // Re-screen on every edit: a swapped-in image kept the old post's verdict,
    // because submitDetectNsfw skips objects already marked done. Reconciling
    // here also drops rows for images that were removed.
    const currentGif = typeof updated?.gif_key === 'string' ? updated.gif_key : null;
    await screenPostImages(c.env.DB, c.env, postId, [
      ...(isImageKey(currentGif) ? [currentGif] : []),
      ...imageAttachmentKeys(updated?.attachments),
    ]);

    return c.json({ post: updated });
  } catch (error: unknown) {
    const err = error as { message: string; stack?: string };
    console.error('Edit post error:', error);
    return c.json({ error: 'Failed to edit post', details: err.message || String(error), stack: err.stack }, 500);
  }
});

// GET /api/posts/:id - get single post
posts.get('/posts/:id', async (c) => {
  try {
    const postId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = (await c.env.DB.prepare(
      'SELECT p.*, u.language as author_language FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?',
    )
      .bind(postId)
      .first()) as Record<string, unknown> | null;

    if (!post) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Auto-restore if counter-notification period has passed
    if (post.hidden) {
      await autoRestoreIfEligible(c.env.DB, postId);
      // Re-fetch after potential restore
      const refreshed = (await c.env.DB.prepare('SELECT hidden FROM posts WHERE id = ?').bind(postId).first()) as {
        hidden: number;
      } | null;
      if (refreshed) post.hidden = refreshed.hidden;
    }

    // Check if post is hidden - allow admin bypass
    if (post.hidden && !isAdmin(c.env, c.get('user')?.username ?? '')) {
      return c.json({ error: 'Gone' }, 410);
    }

    // Fetch poll data if available
    const poll = (await c.env.DB.prepare('SELECT * FROM polls WHERE post_id = ?').bind(postId).first()) as Record<
      string,
      unknown
    > | null;
    if (poll) {
      const { results: options } = await c.env.DB.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY rowid')
        .bind(poll.id as string)
        .all();
      let userVote: string | null = null;
      const currentUserId = c.get('user')?.id;
      if (currentUserId) {
        const vote = (await c.env.DB.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?')
          .bind(poll.id as string, currentUserId)
          .first()) as { option_id: string } | null;
        if (vote) userVote = vote.option_id;
      }
      post.poll = {
        id: poll.id as string,
        question: poll.question as string,
        multipleChoice: !!poll.multiple_choice,
        endsAt: poll.ends_at as string | undefined,
        options,
        userVote,
      };
    }

    await enrichPostsWithQuotes([post as PostRow], c.env.DB);
    await enrichPostsWithAttachments([post as PostRow], c.env.DB);
    await enrichPostsWithReactions([post as PostRow], c.env.DB, c.get('user')?.id);

    return c.json(post);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Get post error:', error);
    return c.json({ error: 'Failed to get post', details: err.message || 'Unknown error' }, 500);
  }
});

// Helper function to get threshold for a category
function getThreshold(category: ReportCategory): number {
  const thresholds: Record<ReportCategory, number> = {
    spam: 3,
    harassment: 3,
    inappropriate: 3,
    misinformation: 3,
    other: 3,
    hate_speech: 3,
    copyright: 1,
    csam: 1,
    malware: 1,
    privacy: 3,
    nsfw_untagged: 2,
  };
  return thresholds[category];
}

// Helper function to get priority for a category
function getPriority(category: ReportCategory): 'critical' | 'high' | 'normal' {
  if (category === 'csam' || category === 'malware') {
    return 'critical';
  }
  if (category === 'copyright') {
    return 'high';
  }
  return 'normal';
}

// Helper function to resolve mentioned usernames to {username, user_id} objects
async function resolveMentions(db: D1Database, mentionedUsernames: string[], currentUsername: string): Promise<string> {
  if (mentionedUsernames.length === 0) return '[]';
  const placeholders = mentionedUsernames.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, username FROM users WHERE LOWER(username) IN (${placeholders})`)
    .bind(...mentionedUsernames.map((u) => u.toLowerCase()))
    .all<{ id: string; username: string }>();
  const userMap = new Map(rows.results?.map((r) => [r.username.toLowerCase(), r]) || []);
  // 同一ユーザーが大文字小文字違いなどで複数回メンションされても1件に集約する
  const seenUserIds = new Set<string>();
  const resolved = mentionedUsernames
    .map((u) => {
      const user = userMap.get(u.toLowerCase());
      return user ? { username: user.username, user_id: user.id } : null;
    })
    .filter((m): m is { username: string; user_id: string } => m !== null)
    .filter((m) => {
      if (seenUserIds.has(m.user_id)) return false;
      seenUserIds.add(m.user_id);
      return true;
    });
  return JSON.stringify(resolved);
}

// Helper function to insert notification
async function insertNotification(
  db: D1Database,
  userId: string,
  type: 'fresh' | 'reported' | 'warned' | 'hidden',
  postId: string,
  actorId?: string,
) {
  const _messages: Record<string, string> = {
    fresh: 'fresed your post',
    reported: 'reported your post',
    warned: 'Your post has been reported for {category}. It may be removed if it violates our ToS.',
    hidden: 'Your post has been removed due to a {category} report.',
  };
  await db
    .prepare('INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)')
    .bind(nanoid(), userId, type, postId, actorId || null)
    .run();
}

// Helper function to insert admin alert
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

async function enrichPostsWithPolls(posts: PostRow[], db: D1Database, currentUserId?: string | null): Promise<void> {
  if (posts.length === 0) return;
  const postIds = posts.map((p) => p.id);
  const placeholders = postIds.map(() => '?').join(',');
  const pollsResult = await db
    .prepare(`SELECT * FROM polls WHERE post_id IN (${placeholders})`)
    .bind(...postIds)
    .all<PollRow>();

  if (!pollsResult.success || pollsResult.results.length === 0) return;

  const pollMap = new Map<string, PollRow>();
  for (const poll of pollsResult.results) {
    pollMap.set(poll.post_id, poll);
  }

  const pollIds = pollsResult.results.map((p: PollRow) => p.id);
  const optPlaceholders = pollIds.map(() => '?').join(',');

  // Parallelize poll options and user votes queries
  const [optsResult, votesResult] = await Promise.all([
    db
      .prepare(`SELECT * FROM poll_options WHERE poll_id IN (${optPlaceholders}) ORDER BY rowid`)
      .bind(...pollIds)
      .all<PollOptionRow>(),
    currentUserId
      ? db
          .prepare(`SELECT poll_id, option_id FROM poll_votes WHERE poll_id IN (${optPlaceholders}) AND user_id = ?`)
          .bind(...pollIds, currentUserId)
          .all<{ poll_id: string; option_id: string }>()
      : Promise.resolve({ success: true, results: [] as Array<{ poll_id: string; option_id: string }> }),
  ]);

  const optsByPoll = new Map<string, PollOptionRow[]>();
  if (optsResult.success) {
    for (const opt of optsResult.results) {
      const pid = opt.poll_id;
      if (!optsByPoll.has(pid)) optsByPoll.set(pid, []);
      optsByPoll.get(pid)!.push(opt);
    }
  }

  const userVotes = new Map<string, string>();
  if (votesResult.success) {
    for (const v of votesResult.results) {
      userVotes.set(v.poll_id, v.option_id);
    }
  }

  for (const post of posts) {
    const poll = pollMap.get(post.id);
    if (poll) {
      const now = new Date();
      const endsAt = poll.ends_at || null;
      const expired = endsAt ? new Date(endsAt) <= now : false;
      post.poll = {
        id: poll.id,
        question: poll.question,
        multipleChoice: !!poll.multiple_choice,
        endsAt,
        options: optsByPoll.get(poll.id) || [],
        userVote: userVotes.get(poll.id) || null,
        expired,
      };
    }
  }
}

/** Quoted post row: the SELECT shape plus an index signature for enrichment. */
type QuotedPostRow = {
  id: string;
  status: string;
  hidden: number | null;
  [key: string]: unknown;
};

/**
 * Batch-fetch quoted posts referenced by the given posts and attach them as
 * `quoted_post`. Only embeds 1 level deep (never recurses) to avoid infinite
 * nesting. Deleted/hidden/absent quoted posts are set to null so the client can
 * render a "post unavailable" placeholder.
 */
async function enrichPostsWithQuotes(posts: PostRow[], db: D1Database): Promise<void> {
  if (posts.length === 0) return;

  const postIds = posts.map((p) => p.id);
  const idPlaceholders = postIds.map(() => '?').join(',');
  const linksResult = await db
    .prepare(`SELECT id, quoted_post_id FROM posts WHERE id IN (${idPlaceholders}) AND quoted_post_id IS NOT NULL`)
    .bind(...postIds)
    .all<{ id: string; quoted_post_id: string }>();

  const links = linksResult.results || [];
  const quotedIds = [...new Set(links.map((r) => r.quoted_post_id))];
  const quotedMap = new Map<string, QuotedPostRow>();

  if (quotedIds.length > 0) {
    const placeholders = quotedIds.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.language as author_language,
              p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key,
              p.thumbnail_key, p.parent_id, p.root_id, COALESCE(p.depth, 0) AS depth,
              COALESCE(p.status, 'published') AS status, p.hidden, p.created_at
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.id IN (${placeholders})`,
      )
      .bind(...quotedIds)
      .all<QuotedPostRow>();

    const visible = (result.results || []).filter((quoted) => quoted.status === 'published' && !quoted.hidden);
    for (const quoted of visible) {
      quotedMap.set(quoted.id, quoted);
    }
    // Quote cards render attachments, so the quoted post needs the same
    // enrichment the timeline gives its own posts.
    await enrichPostsWithAttachments(visible, db);
  }

  for (const post of posts) {
    const link = links.find((r) => r.id === post.id);
    post.quoted_post_id = link?.quoted_post_id ?? null;
    post.quoted_post = link ? quotedMap.get(link.quoted_post_id) || null : null;
  }
}

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

  // Collect unique custom stamp names used in reactions
  const stampNames = new Set<string>();
  for (const row of summaryResult.results || []) {
    if (/^:.+:$/.test(row.emoji)) {
      stampNames.add(row.emoji);
    }
  }

  // Resolve custom stamp names to image URLs
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
// Helper: add N business days to a date (weekdays only, no holiday calendar)
function addBusinessDays(date: Date, days: number): Date {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

// POST /api/posts/:id/counter-notice - file a DMCA counter-notification (protected)
posts.post('/posts/:id/counter-notice', requireAuth, async (c) => {
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

    if (!name || !email || !address || !phone) {
      return c.json({ error: 'Name, email, address, and phone are required' }, 400);
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
        name,
        email,
        address,
        phone,
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
    const err = error as { message?: string };
    console.error('Counter-notice error:', error);
    return c.json({ error: 'Failed to file counter-notice', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/posts/:id/versions - list archived versions of a game (public)
posts.get('/posts/:id/versions', async (c) => {
  try {
    const postId = c.req.param('id');
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const { results } = (await c.env.DB.prepare(
      'SELECT id, version_number, changelog, thumbnail_key, created_at FROM game_versions WHERE post_id = ? ORDER BY version_number DESC',
    )
      .bind(postId)
      .all()) as {
      results: Array<{
        id: string;
        version_number: number;
        changelog: string | null;
        thumbnail_key: string | null;
        created_at: string;
      }>;
    };

    const versions = results.map((r) => ({
      id: r.id,
      versionNumber: r.version_number,
      changelog: r.changelog || null,
      thumbnailKey: r.thumbnail_key || null,
      createdAt: r.created_at,
    }));

    return c.json({ versions });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('List game versions error:', error);
    return c.json({ error: 'Failed to list versions', details: err.message }, 500);
  }
});

// POST /api/posts/:id/versions/prepare - reserve an upload slot for a new version (owner only)
posts.post('/posts/:id/versions/prepare', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id');
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const post = (await c.env.DB.prepare('SELECT id, user_id, payload_key, status FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as { id: string; user_id: string; payload_key: string | null; status: string } | null;

    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Post is not published' }, 400);
    if (
      !post.payload_key ||
      !(
        post.payload_key.startsWith('zip/') ||
        post.payload_key.startsWith('html/') ||
        post.payload_key.startsWith('versions/')
      )
    ) {
      return c.json({ error: 'Only ZIP/HTML5 games can be versioned' }, 400);
    }

    const versionId = crypto.randomUUID();
    const storageKey = `versions/${postId}/${versionId}.zip`;
    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;

    return c.json({ postId, versionId, zipUploadUrl: uploadUrl, zipKey: storageKey });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Prepare game version error:', error);
    return c.json({ error: 'Failed to prepare version', details: err.message }, 500);
  }
});

// POST /api/posts/:id/versions/commit - finalize a newly uploaded version (owner only)
posts.post('/posts/:id/versions/commit', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id')!;
    if (!c.env.DB || !c.env.BUCKET) return c.json({ error: 'Database/Storage not available' }, 500);

    const body = (await c.req.json()) as { versionId?: string; changelog?: string };
    if (!body.versionId) return c.json({ error: 'versionId is required' }, 400);

    const post = (await c.env.DB.prepare('SELECT id, user_id, payload_key, status, created_at FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      payload_key: string | null;
      status: string;
      created_at: string;
    } | null;

    if (!post || post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Post is not published' }, 400);

    const newKey = `versions/${postId}/${body.versionId}.zip`;
    const head = await c.env.BUCKET.head(newKey);
    if (!head) return c.json({ error: 'Uploaded file not found' }, 400);

    const maxRow = (await c.env.DB.prepare('SELECT MAX(version_number) as m FROM game_versions WHERE post_id = ?')
      .bind(postId)
      .first()) as { m: number | null } | null;
    const max = maxRow?.m ?? 0;

    const now = new Date().toISOString();
    const changelog = typeof body.changelog === 'string' ? body.changelog.trim().slice(0, 2000) || null : null;

    // Archive the original release as v1 the first time a game is versioned,
    // so players can still roll back to it after an update.
    const archiveOriginal = max === 0 && !!post.payload_key && post.payload_key !== newKey;
    if (archiveOriginal) {
      await c.env.DB.prepare(
        'INSERT INTO game_versions (id, post_id, version_number, payload_key, thumbnail_key, changelog, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(crypto.randomUUID(), postId, 1, post.payload_key, null, null, user.id, post.created_at)
        .run();
    }

    // When the original was archived as v1, the new release becomes v2.
    const newVersionNumber = archiveOriginal ? 2 : max + 1;
    await c.env.DB.prepare(
      'INSERT INTO game_versions (id, post_id, version_number, payload_key, thumbnail_key, changelog, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(body.versionId, postId, newVersionNumber, newKey, null, changelog, user.id, now)
      .run();

    await c.env.DB.prepare('UPDATE posts SET payload_key = ?, edited_at = ?, created_at = ? WHERE id = ?')
      .bind(newKey, now, now, postId)
      .run();

    const execCtx = (c as unknown as { executionCtx?: { waitUntil: (p: Promise<unknown>) => void } }).executionCtx;
    if (execCtx?.waitUntil) {
      const bucket = c.env.BUCKET;
      const db = c.env.DB;
      const versionId = body.versionId ?? null;
      if (bucket && db) {
        execCtx.waitUntil(
          (async () => {
            try {
              // Clear old extraction manifests so the new version's files
              // overwrite the stale ones instead of being silently skipped.
              await Promise.all([
                bucket.delete(`wvfs/${postId}/.wvfs-manifest`),
                versionId ? bucket.delete(`wvfs/${postId}/${versionId}/.wvfs-manifest`) : Promise.resolve(),
              ]);

              // Extract to the default (non-versioned) path so the latest version
              // serves from the plain /api/wvfs-zip/<postId> URL, and to the
              // versioned path so ?v=<id> also resolves to it.
              await extractZipToR2(bucket, newKey, postId);
              if (versionId) {
                await extractZipToR2(bucket, newKey, postId, versionId);
              }
            } catch (e) {
              console.error('Background ZIP extraction failed for version:', e);
            }
            try {
              await extractGameDescription(bucket, db, newKey, postId);
            } catch (e) {
              console.error('Background game description extraction failed:', e);
            }
          })(),
        );
      }
    }

    return c.json({ ok: true, versionId: body.versionId, versionNumber: newVersionNumber });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Commit game version error:', error);
    return c.json({ error: 'Failed to commit version', details: err.message }, 500);
  }
});

export default posts;
