import { Hono } from 'hono';
import { clampLimit } from '../../lib/pagination.ts';
import { resolveRequestUser } from '../helpers.ts';
import type { Bindings, PostRow, Variables } from '../types.ts';
import { enrichFeedPosts } from './posts/helpers.ts';

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

interface Cursor {
  score: number;
  createdAt: string;
  id: string;
}

/** Cursors are opaque to the client: `score,created_at,id`, in that order. */
function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length !== 3) return null;
  const [scoreRaw, createdAt, id] = parts;
  const score = Number(scoreRaw);
  if (!createdAt || !id || !Number.isFinite(score)) return null;
  return { score, createdAt, id };
}

function encodeCursor(post: PoolPost): string {
  return `${post.pool_score},${post.created_at},${post.id}`;
}

federated.get('/federated/posts', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

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

  // Keyset pagination on the same tuple as ORDER BY. A tie on score falls back
  // to creation time and then the post id, so no row is skipped or repeated.
  const cursorSql = cursor
    ? `AND (pm.score < ? OR (pm.score = ? AND p.created_at < ?)
         OR (pm.score = ? AND p.created_at = ? AND p.id < ?))`
    : '';
  const cursorParams = cursor
    ? [cursor.score, cursor.score, cursor.createdAt, cursor.score, cursor.createdAt, cursor.id]
    : [];

  const result = await c.env.DB.prepare(
    `SELECT p.*, pm.score AS pool_score
       FROM posts p
       JOIN ap_pool_metrics pm ON pm.post_id = p.id
       WHERE p.status = 'published' AND p.hidden = 0 AND p.actor_id IS NOT NULL
         ${blockSql} ${cursorSql}
       ORDER BY pm.score DESC, p.created_at DESC, p.id DESC
       LIMIT ?`,
  )
    .bind(...blockParams, ...cursorParams, limit)
    .all();

  if (!result.success) {
    console.error('Federated pool query failed:', result);
    return c.json({ error: 'Failed to fetch federated posts' }, 500);
  }

  const posts = (result.results ?? []) as PoolPost[];
  await enrichFeedPosts(posts, c.env.DB, currentUserId);

  const last = posts.at(-1);
  const nextCursor = last && posts.length >= limit ? encodeCursor(last) : null;
  return c.json({ posts, next_cursor: nextCursor });
});

export default federated;
