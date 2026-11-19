import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { cosineSimilarity } from '../../../shared/recommendation/vector.ts';
import { RECOMMENDATION_VECTOR_DIM } from '../../../shared/recommendation/vector-codec.ts';
import type { ReportCategory } from '../../../shared/types/post.ts';
import { buildDeleteActivity } from '../../lib/activitypub/activities';
import { enrichPostsWithRemoteAuthors } from '../../lib/activitypub/authors';
import { deliverToFollowers } from '../../lib/activitypub/delivery';
import { isAdmin } from '../../lib/admin.ts';
import {
  type AttachmentInput,
  type AttachmentRecord,
  collectAttachmentKeys,
  deleteAttachmentRows,
  enrichPostsWithAttachments,
  imageAttachmentKeys,
  parseAttachmentKey,
  sequenceAttachments,
  sumAttachmentSizes,
  validateAttachmentInputs,
} from '../../lib/attachments';
import { embedPost, isImageKey, screenPostImages } from '../../lib/crowd';
import { clampLimit } from '../../lib/pagination';
import { EXACT_DUPLICATE_FILTER } from '../../lib/post-visibility';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import { runInBackground } from '../../lib/scan/index';
import { deleteGameTitlesForPosts, USER_TITLE_COLUMNS, USER_TITLE_JOIN } from '../../lib/titles';
import { refreshUserTrustSafe } from '../../lib/trust';
import { enrichPostsWithQuotes, enrichPostsWithReactions } from '../feed-enrichment';
import {
  addBusinessDays,
  batchGetFreshAndBookmarkStatus,
  kvCacheGet,
  kvCacheSet,
  makeCacheKey,
  requireAuth,
  resolveMentions,
} from '../helpers';
import type { Bindings, PostRow, Variables } from '../types';
import { composer } from './posts/composer.ts';
import { engagement } from './posts/engagement.ts';
import { feed } from './posts/feed.ts';
import {
  colorEntitlementError,
  enrichFeedPosts,
  isOwnedMediaKey,
  RECOMMENDED_SELECT,
  resolveAttachmentLimit,
} from './posts/helpers.ts';
import { recommendations } from './posts/recommendations.ts';
import { replies } from './posts/replies.ts';

const posts = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Per-post attachment ceiling for a user: Flaxia+ subscribers get the larger
 * cap, everyone else the free limit.
 */
posts.route('/', feed);
posts.route('/', recommendations);

posts.get('/posts/:id/similar', async (c) => {
  try {
    const postId = c.req.param('id');
    const limit = clampLimit(c.req.query('limit'), 5, 20);
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const currentUserId = c.get('user')?.id;

    // Get the post's embedding
    const embedRow = await c.env.DB.prepare('SELECT embedding, dimensions FROM post_embeddings WHERE post_id = ?')
      .bind(postId)
      .first<{ embedding: string; dimensions: number | null }>();
    if (!embedRow) return c.json({ posts: [] });

    let vector: number[];
    try {
      vector = JSON.parse(embedRow.embedding);
    } catch {
      return c.json({ posts: [] });
    }
    if (!Array.isArray(vector)) return c.json({ posts: [] });

    // Query Vectorize only with the index's current model dimension.
    let similarIds: string[] = [];
    const vectorize = vector.length === RECOMMENDATION_VECTOR_DIM ? c.env.VECTORIZE : undefined;
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
          if (Array.isArray(v) && v.length === vector.length)
            scored.push({ id: row.post_id, sim: cosineSimilarity(vector, v) });
        } catch {
          /* skip */
        }
      }
      scored.sort((a, b) => b.sim - a.sim);
      similarIds = scored.slice(0, limit).map((s) => s.id);
    }

    if (similarIds.length === 0) return c.json({ posts: [] });

    const postsResult = await c.env.DB.prepare(
      `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id IN (${similarIds.map(() => '?').join(',')}) AND p.status = 'published' AND p.hidden = 0 ${EXACT_DUPLICATE_FILTER}`,
    )
      .bind(...similarIds)
      .all();
    const posts = postsResult.results || [];

    await enrichFeedPosts(posts as PostRow[], c.env.DB, currentUserId);

    return c.json({ posts });
  } catch (error: unknown) {
    console.error('Similar posts error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/ads/active - get active ads (public endpoint)
posts.post('/posts/:id/impression', async (c) => {
  try {
    // Unauthenticated counter endpoint: throttle per IP so it cannot be
    // used as an engagement-inflation oracle.
    if (
      !(await checkRateLimit(c.env.CACHE, `post:impression:${getClientIp(c.req.raw)}`, {
        maxRequests: 180,
        windowSeconds: 60,
      }))
    ) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
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
    if (
      !(await checkRateLimit(c.env.CACHE, `post:impression:${getClientIp(c.req.raw)}`, {
        maxRequests: 180,
        windowSeconds: 60,
      }))
    ) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const body = (await c.req.json()) as { post_ids: string[] };

    if (!body.post_ids || !Array.isArray(body.post_ids) || body.post_ids.length === 0) {
      return c.json({ error: 'Invalid request: post_ids array required' }, 400);
    }

    if (body.post_ids.length > 100) {
      return c.json({ error: 'Too many post IDs (max 100)' }, 400);
    }

    const postIds = [...new Set(body.post_ids.filter((postId) => typeof postId === 'string' && postId.length > 0))];
    if (postIds.length === 0) return c.json({ error: 'post_ids must contain post IDs' }, 400);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const placeholders = postIds.map(() => '?').join(',');
    const statements = [
      c.env.DB.prepare(
        `UPDATE posts SET impressions = impressions + 1, engagement_hotness = engagement_hotness + 0.1 WHERE id IN (${placeholders})`,
      ).bind(...postIds),
    ];
    const currentUserId = c.get('user')?.id;
    if (currentUserId) {
      const seenAt = new Date().toISOString();
      const pruneBefore = new Date(Date.now() - 30 * 86400_000).toISOString();
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO user_post_impressions (user_id, post_id, last_seen_at)
           SELECT ?, p.id, ? FROM posts p WHERE p.id IN (${placeholders})
           ON CONFLICT(user_id, post_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        ).bind(currentUserId, seenAt, ...postIds),
        c.env.DB.prepare('DELETE FROM user_post_impressions WHERE user_id = ? AND last_seen_at < ?').bind(
          currentUserId,
          pruneBefore,
        ),
      );
    }
    const results = await c.env.DB.batch(statements);

    if (results.some((result) => !result.success)) {
      console.error('Batch impression update failed:', results);
      return c.json({ error: 'Failed to record impressions' }, 500);
    }

    return c.json({ ok: true, updated: results[0]?.meta?.changes || 0 });
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
posts.route('/', composer);

posts.route('/', engagement);

posts.route('/', replies);

async function addReloadStatus(
  db: D1Database,
  userId: string | undefined,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (!userId || rows.length === 0) return rows;
  const { reloaded } = await batchGetFreshAndBookmarkStatus(
    db,
    userId,
    rows.map((row) => String(row.id)),
  );
  return rows.map((row) => ({ ...row, is_reloaded: reloaded.has(String(row.id)) }));
}

/** Map a user search row to the public shape, including badge + equipped title. */
function mapSearchUserRow(u: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(u.id !== undefined ? { id: u.id } : {}),
    username: u.username,
    display_name: u.display_name || '',
    avatar_key: u.avatar_key || '',
    badge_type: (u.badge_type as string | null) ?? null,
    name_color: (u.name_color as string | null) ?? null,
    equipped_title_id: (u.equipped_title_id as string | null) ?? null,
    title_name: (u.title_name as string | null) ?? null,
    title_name_ja: (u.title_name_ja as string | null) ?? null,
    title_description: (u.title_description as string | null) ?? null,
    title_description_ja: (u.title_description_ja as string | null) ?? null,
    title_icon: (u.title_icon as string | null) ?? null,
  };
}

posts.get('/search', async (c) => {
  try {
    const query = c.req.query('q');
    const type = c.req.query('type') || 'posts';
    const limit = clampLimit(c.req.query('limit'), 20, 50);

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
      return c.json({ ...cached, results: await addReloadStatus(c.env.DB, c.get('user')?.id, cached.results) });
    }

    const tokens = query.trim().split(/\s+/).filter(Boolean);

    if (type === 'users') {
      const cleanQuery = query.trim().replace(/^@/, '');
      const searchTerm = `%${cleanQuery}%`;
      const users = await c.env.DB.prepare(`
        SELECT u.id, u.username, u.display_name, u.bio, u.avatar_key, u.badge_type, u.name_color, u.created_at, ${USER_TITLE_COLUMNS}
        FROM users u
        ${USER_TITLE_JOIN}
        WHERE u.username LIKE ? OR u.display_name LIKE ?
        ORDER BY u.created_at DESC
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
          SELECT u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, ${USER_TITLE_COLUMNS}
          FROM users u
          ${USER_TITLE_JOIN}
          WHERE LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ?
          ORDER BY u.created_at DESC LIMIT ?
        `)
          .bind(searchTerm, searchTerm, limit)
          .all();
        usersResult = (users.results || []).map(mapSearchUserRow);
      }
      return c.json({ type, query, results: [], users: usersResult });
    }

    const whereClause = `WHERE p.status = 'published' AND p.hidden = 0 AND (${conditions.join(' AND ')}) ${EXACT_DUPLICATE_FILTER}`;

    const selectColumns = `
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
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
        SELECT u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, ${USER_TITLE_COLUMNS}
        FROM users u
        ${USER_TITLE_JOIN}
        WHERE LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ?
        ORDER BY u.created_at DESC LIMIT ?
      `)
        .bind(searchTerm, searchTerm, limit)
        .all();
      usersResult = (users.results || []).map(mapSearchUserRow);
    }

    const responseData = {
      type,
      query,
      results: posts.results || [],
      users: usersResult,
    };
    await kvCacheSet(c, cacheKey, responseData, 60);
    return c.json({
      ...responseData,
      results: await addReloadStatus(c.env.DB, c.get('user')?.id, responseData.results),
    });
  } catch (error: unknown) {
    console.error('Search error:', error);
    return c.json({ error: 'Search failed' }, 500);
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

    // Game achievements are scoped to their game post. Remove them with the
    // post so the public title catalog cannot retain orphaned definitions.
    await deleteGameTitlesForPosts(c.env.DB, [post.id, ...descendantIds]);

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
        if (user?.username) {
          const noteId = `${c.env.BASE_URL}/api/notes/${postId}`;
          const activity = buildDeleteActivity(c.env.BASE_URL, user.username, noteId, postId ?? 'unknown');

          // Queue one delivery per remote inbox of the followers
          await deliverToFollowers(c.env, {
            userId: user.id,
            username: user.username,
            activity,
          });
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
    console.error('Delete post error:', error);
    return c.json({ error: 'Failed to delete post' }, 500);
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
      // Keep an already-colored post editable after a lapse, but do not let a
      // non-member add or keep color markers in a *changed* body.
      if (body.text !== post.text && trimmed !== post.text) {
        const colorError = colorEntitlementError(c, trimmed);
        if (colorError) return colorError;
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
    // Client-supplied media keys must name the caller's own posts: otherwise
    // the cleanup below could delete another user's R2 object.
    for (const [field, value] of [
      ['gif_key', body.gif_key],
      ['payload_key', body.payload_key],
      ['swf_key', body.swf_key],
      ['thumbnail_key', body.thumbnail_key],
    ] as const) {
      if (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !(await isOwnedMediaKey(c.env.DB, post.user_id, value))
      ) {
        return c.json({ error: `Media key ${field} does not belong to this account` }, 422);
      }
    }

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
      "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key as payloadKey, p.swf_key as swfKey, p.thumbnail_key as thumbnailKey, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.edited_at FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id = ?",
    )
      .bind(postId)
      .first()) as Record<string, unknown> | null;

    await enrichPostsWithQuotes([updated as PostRow], c.env.DB);
    await enrichPostsWithAttachments([updated as PostRow], c.env.DB);
    await refreshUserTrustSafe(c.env.DB, userId);
    const updatedText = updated?.text;
    if (typeof updatedText === 'string') {
      runInBackground(c, () => embedPost(c.env.DB, c.env, postId, updatedText), 'Background re-index failed');
    }

    // Re-screen on every edit: a swapped-in image kept the old post's verdict,
    // because submitDetectNsfw skips objects already marked done. Reconciling
    // here also drops rows for images that were removed.
    // Runs in the background like the commit path: crowd round-trips can take
    // up to the workload timeout (120s+), which must not gate the edit response.
    const currentGif = typeof updated?.gif_key === 'string' ? updated.gif_key : null;
    screenPostImages(c.env.DB, c.env, postId, [
      ...(isImageKey(currentGif) ? [currentGif] : []),
      ...imageAttachmentKeys(updated?.attachments),
    ]).catch((e) => console.error('Background NSFW re-screen failed:', e));

    return c.json({ post: updated });
  } catch (error: unknown) {
    console.error('Edit post error:', error);
    return c.json({ error: 'Failed to edit post' }, 500);
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
      'SELECT p.*, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, u.frozen_at as author_frozen_at FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id = ?',
    )
      .bind(postId)
      .first()) as Record<string, unknown> | null;

    if (!post) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (post.author_frozen_at) {
      return c.json({ error: 'Gone' }, 410);
    }

    const currentUserId = c.get('user')?.id;
    if (currentUserId) {
      const { reloaded } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, [postId]);
      post.is_reloaded = reloaded.has(postId);
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

    // Check if post is hidden or not published - allow admin bypass
    const isPostAdmin = isAdmin(c.env, c.get('user') ?? null);
    if ((post.hidden || (post.status && post.status !== 'published')) && !isPostAdmin) {
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
    await enrichPostsWithRemoteAuthors([post], c.env.DB);

    return c.json(post);
  } catch (error: unknown) {
    console.error('Get post error:', error);
    return c.json({ error: 'Failed to get post' }, 500);
  }
});

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

export default posts;
