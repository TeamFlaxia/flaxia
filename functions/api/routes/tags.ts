import { Hono } from 'hono';
import { refreshTopicEmbeddings } from '../../lib/crowd';
import { runInBackground } from '../../lib/scan/index';
import { aggregateTopicTags, type TopicPost } from '../../lib/topics';
import type { Bindings, Variables } from '../types';

const tags = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/tags/trending - manual and automatically detected topics from recent posts
tags.get('/tags/trending', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    runInBackground(c, () => refreshTopicEmbeddings(c.env.DB, c.env), 'Topic refresh failed');

    const recentCountParam = c.req.query('recent_count');
    const recentCount = recentCountParam ? parseInt(recentCountParam, 10) : 100;
    const validRecentCount = Number.isNaN(recentCount) || recentCount < 10 || recentCount > 1000 ? 100 : recentCount;

    const result = await c.env.DB.prepare(`
      SELECT id, text, hashtags, auto_topic_tags FROM posts
      WHERE hidden = 0 AND status = 'published' AND parent_id IS NULL
      ORDER BY created_at DESC, id DESC LIMIT ?
    `)
      .bind(validRecentCount)
      .all<TopicPost>();
    if (!result.success) return c.json({ error: 'Failed to fetch trending tags' }, 500);
    const tagsList = aggregateTopicTags(result.results || []);

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

    const result = await c.env.DB.prepare(`
      SELECT DISTINCT value AS tag, COUNT(*) AS count
      FROM posts, json_each(posts.hashtags)
      WHERE posts.hidden = 0 AND posts.status = 'published'
        AND LOWER(value) LIKE ?
      GROUP BY value
      ORDER BY count DESC
      LIMIT ?
    `)
      .bind(prefix + '%', limit)
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
