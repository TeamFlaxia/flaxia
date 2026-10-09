import type { Context, Next } from 'hono';
import { isAdmin } from '../../src/lib/admin';
import { getMeWithSession, getSessionToken } from '../lib/auth';
import type { Bindings, Variables } from './types';

// Shared security headers for all media responses
export const MEDIA_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Disposition': 'inline',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

// Auth middleware — sets user context (null if not authenticated)
export const authMiddleware = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  const method = c.req.method;
  const path = c.req.path;
  // DM media keys (`dm/...`) are private and must be authorized, so we resolve
  // the session for them. Public media is served without a session lookup to
  // keep the hot path cheap.
  const isDmMedia = path.includes('/dm/');
  const skipsSession =
    method === 'GET' &&
    !isDmMedia &&
    (path.startsWith('/api/images/') ||
      path.startsWith('/api/audio/') ||
      path.startsWith('/api/video/') ||
      path.startsWith('/api/documents/') ||
      path === '/api/games' ||
      (path.startsWith('/api/ads/') && path.endsWith('/payload')) ||
      path.startsWith('/api/wvfs-zip/'));
  if (skipsSession) {
    await next();
    return;
  }
  const token = getSessionToken(c.req.raw);
  const sessionData = token ? await getMeWithSession(c.env, token) : null;
  c.set('user', sessionData?.user || null);
  await next();
};

// Require authenticated user
export const requireAuth = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  if (!c.get('user')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

// Require admin role
export const requireAdmin = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  const user = c.get('user');
  if (!user || !isAdmin(c.env as { ADMIN_USERNAMES?: string }, user)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};

// CSRF protection middleware
export const allowedOrigins = new Set([
  'http://localhost:8787',
  'http://localhost:3000',
  'http://localhost:5173',
  'https://flaxia.app',
]);

export function getBaseOrigin(c: { env: { BASE_URL?: string } }): string {
  try {
    return new URL(c.env.BASE_URL || 'https://flaxia.app').origin;
  } catch {
    return 'https://flaxia.app';
  }
}

export const csrfProtection = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }
  const origin = c.req.header('Origin');
  if (origin) {
    const baseOrigin = getBaseOrigin(c);
    if (!allowedOrigins.has(origin) && origin !== baseOrigin) {
      return c.json({ error: 'CSRF validation failed' }, 403);
    }
  }
  await next();
};

// Range request handling for audio/video
export function parseRange(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  let start = match[1] ? parseInt(match[1], 10) : undefined;
  let end = match[2] ? parseInt(match[2], 10) : undefined;

  if (start === undefined && end === undefined) return null;

  if (start === undefined) {
    start = Math.max(0, fileSize - end!);
    end = fileSize - 1;
  } else if (end === undefined) {
    end = fileSize - 1;
  }

  if (start > end || start < 0 || end >= fileSize) return null;

  return { start, end };
}

/**
 * Serve an R2 object, honouring HTTP Range requests.
 */
type R2ObjectLike = { size?: number; body?: BodyInit | null };

type RouteContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export async function handleRangeRequest(
  c: RouteContext,
  key: string,
  object: R2ObjectLike,
  contentType: string,
): Promise<Response> {
  const fileSize = object.size || 0;
  const rangeHeader = c.req.header('Range');

  if (!rangeHeader) {
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=1800',
        'Access-Control-Allow-Origin': 'https://flaxia.app',
        'Accept-Ranges': 'bytes',
        'Content-Length': fileSize.toString(),
        ...MEDIA_SECURITY_HEADERS,
      },
    });
  }

  const range = parseRange(rangeHeader, fileSize);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${fileSize}`,
      },
    });
  }

  const chunkSize = range.end - range.start + 1;
  const ranged = await c.env.BUCKET.get(key, {
    range: { offset: range.start, length: chunkSize },
  });

  if (!ranged) {
    return c.json({ error: 'Media not found' }, 404);
  }

  return new Response(ranged.body, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
      'Content-Length': chunkSize.toString(),
      'Cache-Control': 'private, max-age=1800',
      'Access-Control-Allow-Origin': 'https://flaxia.app',
      'Accept-Ranges': 'bytes',
      ...MEDIA_SECURITY_HEADERS,
    },
  });
}

// KV cache helpers
export async function kvCacheGet<T>(c: RouteContext, key: string): Promise<T | null> {
  try {
    const raw = await c.env.CACHE?.get(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // proceed without cache on KV failure
  }
  return null;
}

export async function kvCacheSet(c: RouteContext, key: string, data: unknown, ttl: number): Promise<void> {
  try {
    await c.env.CACHE?.put(key, JSON.stringify(data), { expirationTtl: ttl });
  } catch (e) {
    console.warn('KV cache write failed:', e);
  }
}

export function makeCacheKey(prefix: string, c: RouteContext, extra?: string, includeUser = true): string {
  const token = getSessionToken(c.req.raw);
  const userId = token ? token.substring(0, 12) : 'anon';
  const query = c.req.raw.url.split('?')[1] || '';
  const userPart = includeUser ? userId : '';
  return `${prefix}:${userPart}:${query}${extra ? ':' + extra : ''}`;
}

// MIME type detection lives in the scan module so the file scanning pipeline
// and the routes share one magic-byte table.
export { detectMimeType, isAllowedImageMime } from '../lib/scan/mime';

// Report helpers
export type ReportCategory =
  | 'spam'
  | 'harassment'
  | 'inappropriate'
  | 'misinformation'
  | 'other'
  | 'hate_speech'
  | 'copyright'
  | 'csam'
  | 'malware'
  | 'privacy'
  | 'nsfw_untagged';

export function getThreshold(category: ReportCategory): number {
  // No auto-hide may be triggered by a single reporter: a hostile account
  // could otherwise take down any post with one report. Categories that must
  // reach moderators fast (csam/malware) raise a critical alert immediately
  // (see report.ts) while still requiring a second, independent reporter
  // before the post is hidden.
  const thresholds: Record<ReportCategory, number> = {
    spam: 3,
    harassment: 3,
    inappropriate: 3,
    misinformation: 3,
    other: 3,
    hate_speech: 3,
    copyright: 2,
    csam: 2,
    malware: 2,
    privacy: 3,
    nsfw_untagged: 2,
  };
  return thresholds[category];
}

export function getPriority(category: ReportCategory): 'critical' | 'high' | 'normal' {
  if (category === 'csam' || category === 'malware') {
    return 'critical';
  }
  if (category === 'copyright') {
    return 'high';
  }
  return 'normal';
}

// Mention resolution
export async function resolveMentions(
  db: D1Database,
  mentionedUsernames: string[],
  currentUsername: string,
): Promise<string> {
  if (mentionedUsernames.length === 0) return '[]';
  void currentUsername;
  // Cap: one query with unbounded placeholders plus one push per mention.
  const capped = mentionedUsernames.slice(0, 10);
  const placeholders = capped.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, username FROM users WHERE LOWER(username) IN (${placeholders})`)
    .bind(...capped.map((u) => u.toLowerCase()))
    .all<{ id: string; username: string }>();
  const userMap = new Map(rows.results?.map((r) => [r.username.toLowerCase(), r]) || []);
  // 同一ユーザーが大文字小文字違いなどで複数回メンションされても1件に集約する
  const seenUserIds = new Set<string>();
  const resolved = capped
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

// Notification helpers
export async function insertNotification(
  db: D1Database,
  userId: string,
  type: string,
  postId: string,
  fromUserId?: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO notifications (user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?)')
    .bind(userId, type, postId, fromUserId ?? null)
    .run();
}

export async function insertAdminAlert(
  db: D1Database,
  postId: string,
  category: string,
  priority: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO admin_alerts (id, post_id, category, priority) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), postId, category, priority)
    .run();
}

// Business days helper
export function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return result;
}

// Batch get fresh and bookmark status for a set of post IDs
export async function batchGetFreshAndBookmarkStatus(
  db: D1Database,
  userId: string | null,
  postIds: string[],
): Promise<{ freshed: Set<string>; bookmarked: Set<string> }> {
  if (!userId || postIds.length === 0) {
    return { freshed: new Set(), bookmarked: new Set() };
  }

  const placeholders = postIds.map(() => '?').join(',');

  const [freshResult, bookmarkResult] = await Promise.all([
    db
      .prepare(`SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${placeholders})`)
      .bind(userId, ...postIds)
      .all(),
    db
      .prepare(`SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${placeholders})`)
      .bind(userId, ...postIds)
      .all(),
  ]);

  return {
    freshed: new Set(freshResult.results?.map((r: Record<string, unknown>) => r.post_id as string) || []),
    bookmarked: new Set(bookmarkResult.results?.map((r: Record<string, unknown>) => r.post_id as string) || []),
  };
}

// ── Reactions helper ──

export async function ensureReactionsTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS reactions (
           post_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           PRIMARY KEY (post_id, user_id, emoji))`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id)').run();
  } catch (e) {
    console.error('Failed to ensure reactions table:', e);
  }
}

// ── Arcade / game helpers ──

export const ARCADE_EVENT_TYPES = new Set(['view', 'fresh', 'reply', 'fullscreen', 'share']);
export const MAX_ARCADE_EVENTS_PER_REQUEST = 200;
const BATCH_CHUNK_SIZE = 100;

export async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK_SIZE));
  }
}
