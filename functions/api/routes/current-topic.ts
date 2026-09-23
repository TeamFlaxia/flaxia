import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';

const topic = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/current-topic - randomly selected Flash/HTML post
topic.get('/current-topic', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get a random Flash/HTML post — sample 50 candidate IDs, pick one randomly
    const candidates = await c.env.DB.prepare(`
      SELECT id FROM posts
      WHERE (swf_key IS NOT NULL OR payload_key IS NOT NULL)
        AND status = 'published'
        AND hidden = 0
        AND parent_id IS NULL
      ORDER BY id
      LIMIT 50
    `).all<{ id: string }>();

    if (!candidates.results?.length) {
      return c.json({ error: 'No Flash/HTML posts found' }, 404);
    }

    const pick = candidates.results[Math.floor(Math.random() * candidates.results.length)];
    const result = await c.env.DB.prepare(`
      SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.created_at,
             u.display_name, u.avatar_key, u.badge_type, u.language as author_language,
             COALESCE(p.reply_count, 0) as reply_count,
             COALESCE(p.impressions, 0) as impressions,
             p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `)
      .bind(pick.id)
      .first();

    if (!result) {
      return c.json({ error: 'No Flash/HTML posts found' }, 404);
    }

    let hashtags = [];
    try {
      hashtags = result.hashtags
        ? typeof result.hashtags === 'string'
          ? JSON.parse(result.hashtags)
          : result.hashtags
        : [];
    } catch (error) {
      console.warn('Failed to parse hashtags:', error);
      hashtags = [];
    }

    const topicPost = {
      id: result.id,
      user_id: result.user_id,
      username: result.username,
      display_name: result.display_name,
      avatar_key: result.avatar_key,
      badge_type: (result.badge_type as string | null) ?? null,
      text: result.text,
      hashtags,
      gif_key: result.gif_key,
      payload_key: result.payload_key,
      swf_key: result.swf_key,
      thumbnail_key: result.thumbnail_key,
      fresh_count: result.fresh_count,
      reply_count: result.reply_count,
      impressions: result.impressions,
      created_at: result.created_at,
      type: result.swf_key ? 'flash' : 'html',
    };

    return c.json(topicPost);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Current topic fetch error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

export default topic;
