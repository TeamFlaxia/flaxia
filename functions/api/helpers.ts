import { FlaxiaClient } from '@flaxia/sdk';
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
  if (
    (c.req.method === 'GET' && c.req.path.startsWith('/api/images/')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/audio/')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/video/')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/zip/')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/swf/')) ||
    (c.req.method === 'GET' && c.req.path === '/api/link-preview') ||
    (c.req.method === 'GET' && c.req.path === '/api/games') ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/ads/') && c.req.path.endsWith('/payload')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/wvfs-zip/'))
  ) {
    await next();
    return;
  }
  const token = getSessionToken(c.req.raw);
  const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
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
  const username = c.get('user')?.username;
  if (!username || !isAdmin(c.env as { ADMIN_USERNAMES: string }, username)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};

// CSRF protection middleware
export const allowedOrigins = new Set([
  'http://localhost:8787',
  'http://localhost:5173',
  'https://flaxia.app',
  'https://sandbox.flaxia.app',
]);

export function getBaseOrigin(c: any): string {
  try {
    return new URL(c.env.BASE_URL || 'https://flaxia.app').origin;
  } catch {
    return 'https://flaxia.app';
  }
}

export const csrfProtection = async (c: any, next: any) => {
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

export async function handleRangeRequest(c: any, key: string, object: any, contentType: string): Promise<Response> {
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
    return c.json({ error: 'Video not found' }, 404);
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
export async function kvCacheGet<T>(c: any, key: string): Promise<T | null> {
  try {
    const raw = await c.env.CACHE?.get(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // proceed without cache on KV failure
  }
  return null;
}

export async function kvCacheSet(c: any, key: string, data: unknown, ttl: number): Promise<void> {
  try {
    await c.env.CACHE?.put(key, JSON.stringify(data), { expirationTtl: ttl });
  } catch (e) {
    console.warn('KV cache write failed:', e);
  }
}

export function makeCacheKey(prefix: string, c: any, extra?: string, includeUser = true): string {
  const token = getSessionToken(c.req.raw);
  const userId = token ? token.substring(0, 12) : 'anon';
  const query = c.req.raw.url.split('?')[1] || '';
  const userPart = includeUser ? userId : '';
  return `${prefix}:${userPart}:${query}${extra ? ':' + extra : ''}`;
}

// MIME type detection
const MAGIC_TYPES: { offset: number; bytes: number[]; mime: string }[] = [
  { offset: 0, bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' },
  { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06], mime: 'application/zip' },
  { offset: 0, bytes: [0x43, 0x57, 0x53], mime: 'application/x-shockwave-flash' },
  { offset: 0, bytes: [0x46, 0x57, 0x53], mime: 'application/x-shockwave-flash' },
  { offset: 0, bytes: [0x49, 0x44, 0x33], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xfb], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xf3], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xf2], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xe3], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xe2], mime: 'audio/mpeg' },
  { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45], mime: 'audio/wav' },
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], mime: 'audio/ogg' },
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm' },
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], mime: 'video/mp4' },
];

export function detectMimeType(data: ArrayBuffer): string | null {
  const header = new Uint8Array(data, 0, 12);
  if (
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    (header[0] === 0x3c && header[1] === 0x21 && header[2] === 0x44 && header[3] === 0x4f) ||
    (header[0] === 0x3c && header[1] === 0x68 && header[2] === 0x74 && header[3] === 0x6d) ||
    (header[0] === 0x3c && header[1] === 0x48 && header[2] === 0x54 && header[3] === 0x4d)
  ) {
    return 'text/html';
  }
  for (const t of MAGIC_TYPES) {
    if (t.bytes.every((b, i) => header[t.offset + i] === b)) {
      return t.mime;
    }
  }
  return null;
}

export function isAllowedImageMime(
  mime: string | null,
): mime is 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  return !!mime && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime);
}

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
  const thresholds: Record<ReportCategory, number> = {
    spam: 3,
    harassment: 3,
    inappropriate: 3,
    misinformation: 3,
    other: 3,
    hate_speech: 3,
    copyright: 1,
    csam: 1,
    malware: 1,
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
  const placeholders = mentionedUsernames.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, username FROM users WHERE LOWER(username) IN (${placeholders})`)
    .bind(...mentionedUsernames.map((u) => u.toLowerCase()))
    .all<{ id: string; username: string }>();
  const userMap = new Map(rows.results?.map((r) => [r.username.toLowerCase(), r]) || []);
  return JSON.stringify(
    mentionedUsernames
      .map((u) => {
        const user = userMap.get(u.toLowerCase());
        return user ? { username: user.username, user_id: user.id } : null;
      })
      .filter(Boolean),
  );
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
    .prepare('INSERT INTO notifications (user_id, type, post_id, from_user_id) VALUES (?, ?, ?, ?)')
    .bind(userId, type, postId, fromUserId ?? null)
    .run();
}

export async function insertAdminAlert(
  db: D1Database,
  postId: string,
  category: string,
  priority: string,
  reason?: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO admin_alerts (post_id, category, priority, reason, status) VALUES (?, ?, ?, ?, ?)')
    .bind(postId, category, priority, reason ?? '', 'pending')
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

// ── NSFW scan helpers ──

const IMAGE_KEY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const nsfwScanPosts = new Set<string>();
let lastNsfwSubmitTime = 0;
const NSFW_RATE_LIMIT_MS = 10_000;

export async function ensureNsfwScansTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS post_nsfw_scans (
           post_id TEXT PRIMARY KEY, task_id TEXT,
           status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'done', 'failed')),
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), scanned_at TEXT)`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_nsfw_scans_status ON post_nsfw_scans(status, created_at)').run();
  } catch (e) {
    console.error('Failed to ensure post_nsfw_scans table:', e);
  }
}

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

async function markNsfwScan(db: D1Database, postId: string, status: string, taskId?: string): Promise<void> {
  try {
    if (status === 'submitted') {
      await db
        .prepare('INSERT OR IGNORE INTO post_nsfw_scans (post_id, status) VALUES (?, ?)')
        .bind(postId, status)
        .run();
    } else {
      await db
        .prepare('UPDATE post_nsfw_scans SET status = ?, scanned_at = ? WHERE post_id = ?')
        .bind(status, new Date().toISOString(), postId)
        .run();
    }
    if (taskId && status === 'submitted') {
      await db.prepare('UPDATE post_nsfw_scans SET task_id = ? WHERE post_id = ?').bind(taskId, postId).run();
    }
  } catch (e) {
    console.error(`Failed to record NSFW scan state for post ${postId}:`, e);
  }
}

export async function submitDetectNsfw(
  db: D1Database,
  orchestratorUrl: string,
  apiKey: string,
  baseUrl: string,
  postId: string,
  gifKey: string | null,
): Promise<void> {
  const normalizedUrl = orchestratorUrl.replace(/\/+$/, '');
  if (!normalizedUrl || !apiKey || !gifKey) return;

  const lower = gifKey.toLowerCase();
  if (!IMAGE_KEY_EXTENSIONS.some((ext) => lower.endsWith(ext))) return;

  if (nsfwScanPosts.has(postId)) return;
  nsfwScanPosts.add(postId);

  const now = Date.now();
  if (now - lastNsfwSubmitTime < NSFW_RATE_LIMIT_MS) {
    nsfwScanPosts.delete(postId);
    return;
  }
  lastNsfwSubmitTime = now;

  try {
    await ensureNsfwScansTable(db);

    const existing = (await db
      .prepare('SELECT status FROM post_nsfw_scans WHERE post_id = ?')
      .bind(postId)
      .first()) as { status: string } | null;
    if (existing?.status === 'done') return;

    const client = new FlaxiaClient({ baseUrl: `${normalizedUrl}/crowd`, apiKey });
    const callbackUrl = `${baseUrl || 'https://flaxia.app'}/api/crowd/webhook?type=nsfw&postId=${postId}`;
    const res = await client.submit({
      workload: 'nudenet',
      payload: { imageUrl: `${baseUrl || 'https://flaxia.app'}/api/images/${gifKey}` },
      callbackUrl,
      timeoutMs: 120000,
    } as never);
    await markNsfwScan(db, postId, 'submitted', res.taskId);
    console.log(`NSFW detection task submitted for post ${postId} (task ${res.taskId})`);
  } catch (err) {
    console.error(`NSFW detection submission failed for post ${postId}:`, err);
  } finally {
    nsfwScanPosts.delete(postId);
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
