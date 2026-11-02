import { Hono } from 'hono';
import { enrichPostsWithAttachments } from '../../lib/attachments';
import { clampLimit } from '../../lib/pagination';
import { EXACT_DUPLICATE_CONDITION } from '../../lib/post-visibility';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import {
  buildFtsMatch,
  buildLikePattern,
  type ParsedSearchQuery,
  parseSearchQuery,
  parseSearchTab,
  type SearchTab,
  searchTextTerms,
} from '../../lib/search-query';
import { searchWeb, type WebSearchResult } from '../../lib/search-web';
import { kvCacheGet, kvCacheSet, makeCacheKey } from '../helpers';
import type { Bindings, PostRow, Variables } from '../types';

const search = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const POST_COLUMNS = `
  p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color,
  u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon,
  u.language AS author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key,
  p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) AS reload_count,
  COALESCE(p.bookmark_count, 0) AS bookmark_count, COALESCE(p.reply_count, 0) AS reply_count,
  COALESCE(p.impressions, 0) AS impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) AS depth,
  COALESCE(p.status, 'published') AS status, p.created_at, p.edited_at, p.quoted_post_id
`;

interface QueryParts {
  where: string[];
  params: Array<string | number>;
}

function buildMatch(parsed: ParsedSearchQuery, fts: string | null): QueryParts {
  if (fts) {
    return { where: ['search_fts MATCH ?'], params: [fts] };
  }

  const terms = searchTextTerms(parsed);
  if (terms.length === 0) return { where: [], params: [] };

  const where: string[] = [];
  const params: string[] = [];
  for (const term of terms) {
    where.push(`(
      d.title LIKE ? ESCAPE '\\'
      OR d.body LIKE ? ESCAPE '\\'
      OR d.tags LIKE ? ESCAPE '\\'
    )`);
    const pattern = buildLikePattern(term);
    params.push(pattern, pattern, pattern);
  }
  return { where, params };
}

function buildPostFilters(parsed: ParsedSearchQuery): QueryParts {
  const where: string[] = [];
  const params: Array<string | number> = [];

  for (const tag of parsed.hashtags) {
    where.push('EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?)');
    params.push(tag);
  }
  for (const username of parsed.from) {
    where.push('p.username = ? COLLATE NOCASE');
    params.push(username);
  }

  return { where, params };
}

function buildUserFilters(parsed: ParsedSearchQuery): QueryParts {
  const where: string[] = [];
  const params: Array<string | number> = [];

  for (const username of parsed.from) {
    where.push('u.username = ? COLLATE NOCASE');
    params.push(username);
  }

  return { where, params };
}

async function searchPosts(
  db: D1Database,
  parsed: ParsedSearchQuery,
  options: { limit: number; gamesOnly: boolean; currentUserId: string | null },
): Promise<PostRow[]> {
  if (options.limit <= 0) return [];

  const fts = buildFtsMatch(parsed);
  const match = buildMatch(parsed, fts);
  const filters = buildPostFilters(parsed);
  const where: string[] = [
    "d.document_type = 'post'",
    "p.status = 'published'",
    'p.hidden = 0',
    'u.frozen_at IS NULL',
    EXACT_DUPLICATE_CONDITION,
    ...match.where,
    ...filters.where,
  ];
  const params: Array<string | number> = [...match.params, ...filters.params];

  if (options.gamesOnly) {
    where.push("p.payload_key IS NOT NULL AND p.payload_key != '' AND (p.swf_key IS NULL OR p.swf_key = '')");
  }
  if (options.currentUserId) {
    where.push('NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = ? AND b.blocked_id = p.user_id)');
    params.push(options.currentUserId);
  }

  const rank = fts ? 'bm25(search_fts, 5.0, 1.0, 3.0, 2.0)' : '0';
  const order = fts ? 'rank ASC, p.created_at DESC' : 'p.created_at DESC';
  const ftsJoin = fts ? 'JOIN search_fts ON search_fts.rowid = d.rowid' : '';

  const result = await db
    .prepare(`
      SELECT ${POST_COLUMNS}, ${rank} AS rank
      FROM search_documents d
      JOIN posts p ON p.id = d.ref_id
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN titles t ON t.id = u.equipped_title_id
      ${ftsJoin}
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?
    `)
    .bind(...params, options.limit)
    .all<PostRow>();

  const posts = result.results || [];
  await enrichPostsWithAttachments(posts, db);
  return posts;
}

interface SearchUser {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_key: string | null;
  badge_type: string | null;
  name_color: string | null;
  created_at: string;
}

async function searchUsers(
  db: D1Database,
  parsed: ParsedSearchQuery,
  options: { limit: number; currentUserId: string | null },
): Promise<SearchUser[]> {
  if (options.limit <= 0) return [];

  const fts = buildFtsMatch(parsed);
  const match = buildMatch(parsed, fts);
  const filters = buildUserFilters(parsed);
  const where: string[] = ['d.document_type = ?', 'u.frozen_at IS NULL', ...match.where, ...filters.where];
  const params: Array<string | number> = ['user', ...match.params, ...filters.params];

  if (options.currentUserId) {
    where.push('NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = ? AND b.blocked_id = u.id)');
    params.push(options.currentUserId);
  }

  const rank = fts ? 'bm25(search_fts, 5.0, 1.0, 3.0, 2.0)' : '0';
  const order = fts ? 'rank ASC, u.created_at DESC' : 'u.created_at DESC';
  const ftsJoin = fts ? 'JOIN search_fts ON search_fts.rowid = d.rowid' : '';

  const result = await db
    .prepare(`
      SELECT u.id, u.username, u.display_name, u.bio, u.avatar_key, u.badge_type, u.name_color,
             u.created_at, ${rank} AS rank
      FROM search_documents d
      JOIN users u ON u.id = d.ref_id
      ${ftsJoin}
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?
    `)
    .bind(...params, options.limit)
    .all<SearchUser>();

  return result.results || [];
}

function tabLimits(tab: SearchTab, limit: number): { posts: number; users: number; games: number; web: number } {
  switch (tab) {
    case 'posts':
      return { posts: limit, users: 0, games: 0, web: 0 };
    case 'users':
      return { posts: 0, users: limit, games: 0, web: 0 };
    case 'games':
      return { posts: 0, users: 0, games: limit, web: 0 };
    case 'web':
      return { posts: 0, users: 0, games: 0, web: limit };
    default:
      return {
        posts: limit,
        users: Math.min(5, limit),
        games: Math.min(10, limit),
        web: Math.min(10, limit),
      };
  }
}

search.get('/search/v2', async (c) => {
  const startedAt = Date.now();

  try {
    const rawQuery = c.req.query('q') || '';
    const parsed = parseSearchQuery(rawQuery);
    const tab = parseSearchTab(c.req.query('tab'));
    const limit = clampLimit(c.req.query('limit'), 20, 50);

    if (searchTextTerms(parsed).length === 0 && parsed.hashtags.length === 0 && parsed.from.length === 0) {
      return c.json({ error: 'Search query required' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'Database not available' }, 500);

    const currentUserId = c.get('user')?.id ?? null;
    const allowed = await checkRateLimit(c.env.CACHE, `searchv2:${currentUserId ?? getClientIp(c.req.raw)}`, {
      maxRequests: currentUserId ? 60 : 30,
      windowSeconds: 60,
    });
    if (!allowed) return c.json({ error: 'Too many requests' }, 429);

    const cacheKey = makeCacheKey('searchv2', c, `${tab}:${limit}`, true);
    const cached = await kvCacheGet<{
      query: string;
      tab: SearchTab;
      posts: PostRow[];
      users: SearchUser[];
      games: PostRow[];
      web: WebSearchResult[];
      took_ms: number;
    }>(c, cacheKey);
    if (cached) return c.json(cached);

    const limits = tabLimits(tab, limit);
    const [posts, users, games] = await Promise.all([
      searchPosts(db, parsed, { limit: limits.posts, gamesOnly: false, currentUserId }),
      searchUsers(db, parsed, { limit: limits.users, currentUserId }),
      searchPosts(db, parsed, { limit: limits.games, gamesOnly: true, currentUserId }),
    ]);

    let web: WebSearchResult[] = [];
    const webQuery = searchTextTerms(parsed).join(' ');
    if (limits.web > 0 && webQuery && c.env.ENVIRONMENT !== 'test') {
      try {
        web = await searchWeb(webQuery, {
          limit: limits.web,
          language: c.req.header('Accept-Language')?.split(',')[0]?.trim(),
          sites: parsed.sites,
        });
      } catch (error) {
        console.error('Web search failed:', error);
      }
    }

    const payload = {
      query: parsed.raw,
      tab,
      posts,
      users,
      games,
      web,
      took_ms: Date.now() - startedAt,
    };
    await kvCacheSet(c, cacheKey, payload, 60);
    return c.json(payload);
  } catch (error) {
    console.error('Search v2 failed:', error);
    return c.json({ error: 'Search failed' }, 500);
  }
});

export default search;
