import { Hono } from 'hono';
import { refreshExternalFeed } from '../../lib/external-feed';
import { clampLimit } from '../../lib/pagination';
import { kvCacheGet, kvCacheSet, makeCacheKey } from '../helpers';
import type { Bindings, Variables } from '../types';

const externalFeed = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const ALLOWED_SOURCES = new Set(['all', 'arxiv', 'hackernews']);

const EMPTY_RETRY_MINUTES = 5;
const STALE_MINUTES = 60;

function isOlderThan(lastFetchedAt: string | null, minutes: number): boolean {
  if (!lastFetchedAt) return true;
  const last = Date.parse(lastFetchedAt);
  if (Number.isNaN(last)) return true;
  return Date.now() - last > minutes * 60 * 1000;
}

interface ExternalItemRow {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  source_label: string;
  publish_at: string;
  author: string;
  tags: string;
}

function toItem(row: ExternalItemRow) {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags || '[]');
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    url: row.url,
    source: row.source,
    source_label: row.source_label,
    publish_at: row.publish_at,
    author: row.author,
    tags,
  };
}

// GET /api/external-feed/sources - enabled external sources for the timeline dropdown
externalFeed.get('/external-feed/sources', async (c) => {
  try {
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);
    const result = await c.env.DB.prepare(
      'SELECT source, label AS source_label FROM external_sources WHERE enabled = 1 ORDER BY source ASC',
    ).all<{ source: string; source_label: string }>();
    return c.json({ sources: result.results || [] }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (error: unknown) {
    console.error('External feed sources error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/external-feed?source=all|arxiv|hackernews&cursor=<publish_at>,<id>&limit=20
externalFeed.get('/external-feed', async (c) => {
  try {
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);
    const source = c.req.query('source') || 'all';
    if (!ALLOWED_SOURCES.has(source)) {
      return c.json({ error: 'Unknown source' }, 400);
    }
    const limit = clampLimit(c.req.query('limit'), 20, 50);
    const cursor = c.req.query('cursor');

    const cacheKey = makeCacheKey('external-feed', c, `${source}:${limit}:${cursor ?? ''}`, false);

    // The hourly cron (queue-worker) is the primary refresh path, but it does
    // not run under `wrangler pages dev`, so a fresh local database starts
    // with zero items. Refresh on demand when the feed has never been
    // fetched (or is clearly stale) so `npm run dev` shows arXiv / Hacker News
    // without waiting for the next cron tick. Test env stays hermetic.
    let bypassCache = false;
    if (c.env.ENVIRONMENT !== 'test' && !cursor) {
      try {
        const freshnessRows = (
          source === 'all'
            ? await c.env.DB.prepare('SELECT source, last_fetched_at FROM external_sources WHERE enabled = 1').all<{
                source: string;
                last_fetched_at: string | null;
              }>()
            : await c.env.DB.prepare(
                'SELECT source, last_fetched_at FROM external_sources WHERE enabled = 1 AND source = ?',
              )
                .bind(source)
                .all<{ source: string; last_fetched_at: string | null }>()
        ).results;
        if (freshnessRows.length > 0) {
          const lastFetched = freshnessRows.map((row) => row.last_fetched_at);
          const countRow =
            source === 'all'
              ? await c.env.DB.prepare('SELECT COUNT(*) AS n FROM external_items').first<{ n: number }>()
              : await c.env.DB.prepare('SELECT COUNT(*) AS n FROM external_items WHERE source = ?')
                  .bind(source)
                  .first<{ n: number }>();
          const count = countRow?.n ?? 0;
          if (count === 0 && lastFetched.some((value) => isOlderThan(value, EMPTY_RETRY_MINUTES))) {
            try {
              await refreshExternalFeed(c.env);
            } catch (refreshError: unknown) {
              console.error('External feed lazy refresh failed:', (refreshError as Error).message);
            }
            bypassCache = true;
          } else if (count > 0 && lastFetched.some((value) => isOlderThan(value, STALE_MINUTES))) {
            const execCtx = (c as unknown as { executionCtx?: { waitUntil: (p: Promise<unknown>) => void } })
              .executionCtx;
            const pending = refreshExternalFeed(c.env).catch((refreshError: unknown) => {
              console.error('External feed background refresh failed:', (refreshError as Error).message);
            });
            if (execCtx?.waitUntil) {
              execCtx.waitUntil(pending);
            }
          }
        }
      } catch (refreshError: unknown) {
        console.error('External feed refresh check failed:', refreshError);
      }
    }

    if (!bypassCache) {
      const cached = await kvCacheGet<{ items: ReturnType<typeof toItem>[]; next_cursor: string | null }>(c, cacheKey);
      if (cached) {
        return c.json(cached, 200, { 'Cache-Control': 'public, max-age=60' });
      }
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (source !== 'all') {
      conditions.push('ei.source = ?');
      params.push(source);
    }
    if (cursor) {
      const comma = cursor.indexOf(',');
      if (comma <= 0) return c.json({ error: 'Invalid cursor' }, 400);
      const cursorPublishAt = cursor.slice(0, comma);
      const cursorId = cursor.slice(comma + 1);
      if (!cursorId) return c.json({ error: 'Invalid cursor' }, 400);
      conditions.push('(ei.publish_at < ? OR (ei.publish_at = ? AND ei.id < ?))');
      params.push(cursorPublishAt, cursorPublishAt, cursorId);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await c.env.DB.prepare(
      `SELECT ei.id, ei.title, ei.summary, ei.url, ei.source, es.label AS source_label,
              ei.publish_at, ei.author, ei.tags
       FROM external_items ei
       JOIN external_sources es ON es.source = ei.source
       ${whereClause}
       ORDER BY ei.publish_at DESC, ei.id DESC
       LIMIT ?`,
    )
      .bind(...params, limit + 1)
      .all<ExternalItemRow>();

    let rows = result.results || [];
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      nextCursor = `${last.publish_at},${last.id}`;
      rows = rows.slice(0, limit);
    }

    const responseData = { items: rows.map(toItem), next_cursor: nextCursor };
    if (rows.length > 0) {
      await kvCacheSet(c, cacheKey, responseData, 60);
    }
    return c.json(responseData, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (error: unknown) {
    console.error('External feed error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default externalFeed;
