import { Hono } from 'hono';
import { clampLimit } from '../../lib/pagination.ts';
import { resolveRequestUser } from '../helpers.ts';
import { type Bindings, dbFromContext, type PostRow, type Variables } from '../types.ts';
import { discoverForEmptyFeed } from './federated-discovery.ts';
import { enrichFeedPosts, visibilityFilter } from './posts/helpers.ts';

/**
 * Federated popularity timeline.
 *
 * The pool is populated by the federation worker; this endpoint only reads it.
 * Rows are ordered by the cached remote popularity score, never by
 * `created_at`, so the tab is a ranked discovery surface rather than a second
 * chronological feed.
 */
const federated = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type PoolPost = PostRow & { pool_score: number };

/** A cursor tracks the posts already served, not a mutable score threshold. */
interface Cursor {
  seen: string[];
}

const CURSOR_PREFIX = 'v2.';
/** Bound the URL size of a cursor; beyond this depth pagination stops safely. */
const MAX_CURSOR_IDS = 500;
// Cloudflare rejects URLs above ~16 KB. 500 ten-char ids encode to ~8.7 KB,
// which leaves room for the rest of the query string.
const MAX_CURSOR_CHARS = 12_000;

function encodeBase64Url(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

/**
 * Scores are rewritten by the hourly discovery run. A keyset cursor holding
 * `pm.score` can therefore skip a post that rises or repeat one that falls
 * between pages. Carrying every id already served keeps the live ranking but
 * guarantees that no post is skipped or repeated across a cron run.
 */
function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw?.startsWith(CURSOR_PREFIX) || raw.length > MAX_CURSOR_CHARS + CURSOR_PREFIX.length) return null;
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(raw.slice(CURSOR_PREFIX.length)));
    if (!parsed || typeof parsed !== 'object') return null;
    const seen = (parsed as { seen?: unknown }).seen;
    if (!Array.isArray(seen) || seen.length === 0 || seen.length > MAX_CURSOR_IDS) return null;
    if (!seen.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)) return null;
    return { seen: [...new Set(seen)] };
  } catch {
    return null;
  }
}

function encodeCursor(seen: string[]): string | null {
  if (seen.length === 0 || seen.length > MAX_CURSOR_IDS) return null;
  const encoded = encodeBase64Url(JSON.stringify({ seen }));
  if (encoded.length > MAX_CURSOR_CHARS) return null;
  return `${CURSOR_PREFIX}${encoded}`;
}

federated.get('/federated/posts', async (c) => {
  const db = dbFromContext(c);
  if (!db) return c.json({ error: 'Database not available' }, 500);

  const limit = clampLimit(c.req.query('limit'), 20, 50);
  const cursor = parseCursor(c.req.query('cursor') ?? undefined);

  // Public endpoint: the viewer is optional, but their blocks still apply.
  const user = await resolveRequestUser(c, c.get('user'));
  const currentUserId = user?.id ?? null;
  const blockSql = currentUserId
    ? `AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
       AND (p.actor_id IS NULL OR p.actor_id NOT IN (SELECT actor_url FROM ap_blocks WHERE local_user_id = ?))`
    : '';
  const blockParams = currentUserId ? [currentUserId, currentUserId] : [];
  const visibility = visibilityFilter(currentUserId);

  // Exclude the posts already served instead of filtering on `pm.score`: the
  // hourly cron rewrites scores, so a score threshold is not a stable boundary.
  // A single JSON bind avoids D1's bind-parameter limit for deep cursors.
  const cursorSql = cursor ? 'AND p.id NOT IN (SELECT value FROM json_each(?))' : '';
  const cursorParams = cursor ? [JSON.stringify(cursor.seen)] : [];

  // Reusable so discovery can be followed by the exact same query, with the
  // same binds, cursor and block/visibility predicates.
  const loadFeed = () =>
    db
      .prepare(
        `SELECT p.*, COALESCE(pm.score, 0) AS pool_score
         FROM posts p
         LEFT JOIN ap_pool_metrics pm ON pm.post_id = p.id
         WHERE p.status = 'published' AND p.hidden = 0 AND p.actor_id IS NOT NULL
           -- The hourly discovery cron may not have populated the pool yet (or it
           -- may have temporarily failed). Until then show the newest public
           -- remote posts instead of an empty tab; once any pool row exists the
           -- ranking is exactly as before.
           AND (pm.post_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM ap_pool_metrics))
           ${blockSql} ${cursorSql} ${visibility.sql}
         ORDER BY COALESCE(pm.score, 0) DESC, p.created_at DESC, p.id DESC
         LIMIT ?`,
      )
      .bind(...blockParams, ...cursorParams, ...visibility.params, limit)
      .all();

  let result = await loadFeed();
  if (!result.success) {
    console.error('Federated pool query failed:', result);
    return c.json({ error: 'Failed to fetch federated posts' }, 500);
  }

  // Cold start: the separate AP worker has not written a pool row yet. Run a
  // bounded discovery right here and re-run the same query. The cheap EXISTS
  // check avoids false triggers when a viewer's blocks hide available posts.
  if (!cursor && (result.results ?? []).length === 0) {
    const state = await db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM ap_pool_metrics) AS has_metrics,
                EXISTS(SELECT 1 FROM posts
                       WHERE actor_id IS NOT NULL AND status = 'published' AND hidden = 0) AS has_remote`,
      )
      .first<{ has_metrics: number; has_remote: number }>();
    if (state && !state.has_metrics && !state.has_remote) {
      const { env } = c;
      if (await discoverForEmptyFeed(env)) {
        result = await loadFeed();
        if (!result.success) {
          console.error('Federated pool query failed after discovery:', result);
          return c.json({ error: 'Failed to fetch federated posts' }, 500);
        }
      }
    }
  }

  const posts = (result.results ?? []) as PoolPost[];
  await enrichFeedPosts(posts, db, currentUserId);

  const seen = [...(cursor?.seen ?? []), ...posts.map((post) => post.id)];
  const nextCursor = posts.length >= limit ? encodeCursor(seen) : null;
  return c.json({ posts, next_cursor: nextCursor });
});

export default federated;
