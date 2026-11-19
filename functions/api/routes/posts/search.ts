import { Hono } from 'hono';
import { enrichPostsWithAttachments } from '../../../lib/attachments';
import { clampLimit } from '../../../lib/pagination';
import { EXACT_DUPLICATE_FILTER } from '../../../lib/post-visibility';
import { USER_TITLE_COLUMNS, USER_TITLE_JOIN } from '../../../lib/titles';
import { enrichPostsWithQuotes, enrichPostsWithReactions } from '../../feed-enrichment';
import { batchGetFreshAndBookmarkStatus, kvCacheGet, kvCacheSet, makeCacheKey } from '../../helpers';
import type { Bindings, PostRow, Variables } from '../../types';

export const search = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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

search.get('/search', async (c) => {
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
