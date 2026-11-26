import { Hono } from 'hono';
import { cosineSimilarity } from '../../../../shared/recommendation/vector.ts';
import { RECOMMENDATION_VECTOR_DIM } from '../../../../shared/recommendation/vector-codec.ts';
import { clampLimit } from '../../../lib/pagination';
import { EXACT_DUPLICATE_FILTER } from '../../../lib/post-visibility';
import { checkRateLimit, getClientIp } from '../../../lib/rate-limit';
import type { Bindings, PostRow, Variables } from '../../types';
import { enrichFeedPosts, RECOMMENDED_SELECT, visibilityFilter } from './helpers.ts';

export const discovery = new Hono<{ Bindings: Bindings; Variables: Variables }>();

discovery.get('/posts/:id/similar', async (c) => {
  try {
    const postId = c.req.param('id');
    const limit = clampLimit(c.req.query('limit'), 5, 20);
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const currentUserId = c.get('user')?.id;
    const visibility = visibilityFilter(currentUserId);

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
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id IN (${similarIds.map(() => '?').join(',')}) AND p.status = 'published' AND p.hidden = 0 ${EXACT_DUPLICATE_FILTER} ${visibility.sql}`,
    )
      .bind(...similarIds, ...visibility.params)
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
discovery.post('/posts/:id/impression', async (c) => {
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
discovery.post('/posts/impressions/batch', async (c) => {
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
