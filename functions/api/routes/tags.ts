import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { visibilityFilter } from './posts/helpers.ts';

const tags = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/tags/trending - top hashtags from recent posts
tags.get('/tags/trending', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const recentCountParam = c.req.query('recent_count');
    const recentCount = recentCountParam ? parseInt(recentCountParam, 10) : 100;
    const validRecentCount = Number.isNaN(recentCount) || recentCount < 10 || recentCount > 1000 ? 100 : recentCount;

    // These aggregates are cached and served publicly, so they must only count
    // posts that are public for everybody. Remote Notes remain eligible.
    const visibility = visibilityFilter(null);

    const result = await c.env.DB.prepare(`
WITH recent_posts AS (
  SELECT p.id, p.hashtags, p.ai_tags
  FROM posts p
  WHERE p.hidden = 0 AND p.status = 'published'
    ${visibility.sql}
  ORDER BY p.created_at DESC
  LIMIT ?
),
all_tags AS (
  SELECT value AS tag, recent_posts.id AS post_id
  FROM recent_posts, json_each(recent_posts.hashtags)
  UNION
  SELECT value AS tag, recent_posts.id AS post_id
  FROM recent_posts, json_each(recent_posts.ai_tags)
)
SELECT
  tag,
  COUNT(DISTINCT post_id) AS count,
  ROUND(
    COUNT(DISTINCT post_id) * 100.0 /
      MAX(1, (SELECT COUNT(*) FROM recent_posts)),
    1
  ) AS percentage
FROM all_tags
GROUP BY tag
ORDER BY count DESC, tag ASC
LIMIT 5
    `)
      .bind(...visibility.params, validRecentCount)
      .all();

    if (!result.success) {
      return c.json({ error: 'Failed to fetch trending tags' }, 500);
    }

    const tagsList = result.results || [];

    return c.json({ tags: tagsList }, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  } catch (error: unknown) {
    console.error('Trending tags error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/tags/suggest?q=prefix - suggest hashtags matching prefix
tags.get('/tags/suggest', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q || q.length < 1) {
      return c.json({ tags: [] });
    }

    const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 20);
    const prefix = q.toLowerCase();

    const visibility = visibilityFilter(null);
    const result = await c.env.DB.prepare(`
      SELECT DISTINCT value AS tag, COUNT(*) AS count
      FROM posts p, json_each(p.hashtags)
      WHERE p.hidden = 0 AND p.status = 'published'
        ${visibility.sql}
        AND LOWER(value) LIKE ?
      GROUP BY value
      ORDER BY count DESC
      LIMIT ?
    `)
      .bind(...visibility.params, prefix + '%', limit)
      .all();

    const tagsList = result.results || [];
    return c.json({ tags: tagsList }, 200, {
      'Cache-Control': 'public, max-age=30',
    });
  } catch (error: unknown) {
    console.error('Tag suggest error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default tags;
