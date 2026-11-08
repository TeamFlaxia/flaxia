import { Hono } from 'hono';
import { refreshExternalFeed } from '../../lib/external-feed';
import { clampLimit } from '../../lib/pagination';
import { computeExternalScore } from '../../lib/scoring';
import { kvCacheGet, kvCacheSet, makeCacheKey } from '../helpers';
import type { Bindings, Variables } from '../types';

const externalFeed = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const EXTERNAL_SOURCES = new Set(['arxiv', 'hackernews']);
const TRENDING_WINDOW_DAYS = 7;

const EMPTY_RETRY_MINUTES = 5;
const STALE_MINUTES = 60;

function isOlderThan(lastFetchedAt: string | null, minutes: number): boolean {
  if (!lastFetchedAt) return true;
  const last = Date.parse(lastFetchedAt);
  if (Number.isNaN(last)) return true;
  return Date.now() - last > minutes * 60 * 1000;
}

/**
 * Parse the requested sources. Accepts the multi-select form
 * `?sources=arxiv,hackernews` (primary) and the legacy single-source form
 * `?source=all|arxiv|hackernews` for existing clients/tests.
 */
function parseSources(c: { req: { query: (key: string) => string | undefined } }): string[] | null {
  const multi = c.req.query('sources');
  if (multi !== undefined) {
    const parts = multi
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0 || parts.some((s) => !EXTERNAL_SOURCES.has(s))) return null;
    return [...new Set(parts)];
  }
  const single = c.req.query('source') || 'all';
  if (single === 'all') return ['arxiv', 'hackernews'];
  if (!EXTERNAL_SOURCES.has(single)) return null;
  return [single];
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

function toItem(row: ExternalItemRow, score: number) {
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
    score,
  };
}

// GET /api/external-feed/sources - enabled external sources for the explore multi-select
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

// GET /api/external-feed?sources=arxiv,hackernews&cursor=<score>,<publish_at>,<id>,<asOf>&limit=20
// Items are ranked by a computed trending score (see computeExternalScore),
// not by publish_at, so they can be interleaved with native posts.
externalFeed.get('/external-feed', async (c) => {
  try {
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);
    const sources = parseSources(c);
    if (!sources) {
      return c.json({ error: 'Unknown source' }, 400);
    }
    const limit = clampLimit(c.req.query('limit'), 20, 50);
    const cursor = c.req.query('cursor');

    let cursorScore: number | null = null;
    let cursorPublishAt: string | null = null;
    let cursorId: string | null = null;
    // Scores decay with time, so the cursor carries the reference time
    // (`asOf`) scores were computed at; later pages reuse it to keep the
    // ranking stable across requests.
    let asOf = Date.now();
    if (cursor) {
      const parts = cursor.split(',');
      if (parts.length < 3 || parts.length > 4) return c.json({ error: 'Invalid cursor' }, 400);
      cursorScore = Number.parseFloat(parts[0]);
      cursorPublishAt = parts[1];
      cursorId = parts[2];
      const parsedAsOf = parts[3] !== undefined ? Number(parts[3]) : Number.NaN;
      if (!Number.isNaN(parsedAsOf) && parsedAsOf > 0) asOf = parsedAsOf;
      if (Number.isNaN(cursorScore!) || !cursorPublishAt || !cursorId) {
        return c.json({ error: 'Invalid cursor' }, 400);
      }
    }

    const cacheKey = makeCacheKey('external-feed', c, `${sources.join(',')}:${limit}:${cursor ?? ''}`, false);

    // The hourly cron (queue-worker) is the primary refresh path, but it does
    // not run under `wrangler pages dev`, so a fresh local database starts
    // with zero items. Refresh on demand when the feed has never been
    // fetched (or is clearly stale). Test env stays hermetic.
    let bypassCache = false;
    if (c.env.ENVIRONMENT !== 'test' && !cursor) {
      try {
        const placeholders = sources.map(() => '?').join(',');
        const freshnessRows = (
          await c.env.DB.prepare(
            `SELECT source, last_fetched_at FROM external_sources WHERE enabled = 1 AND source IN (${placeholders})`,
          )
            .bind(...sources)
            .all<{ source: string; last_fetched_at: string | null }>()
        ).results;
        if (freshnessRows.length > 0) {
          const lastFetched = freshnessRows.map((row) => row.last_fetched_at);
          const countRow = await c.env.DB.prepare(
            `SELECT COUNT(*) AS n FROM external_items WHERE source IN (${placeholders})`,
          )
            .bind(...sources)
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

    // Fetch recent candidates (same 7-day window as native trending) and
    // rank by computed score in JS, since the score depends on a
    // time-decay that must be comparable with post scores.
    const placeholders = sources.map(() => '?').join(',');
    const result = await c.env.DB.prepare(
      `SELECT ei.id, ei.title, ei.summary, ei.url, ei.source, es.label AS source_label,
              ei.publish_at, ei.author, ei.tags
       FROM external_items ei
       JOIN external_sources es ON es.source = ei.source
       WHERE ei.source IN (${placeholders})
         AND ei.publish_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${TRENDING_WINDOW_DAYS} days')
       ORDER BY ei.publish_at DESC, ei.id DESC
       LIMIT ?`,
    )
      .bind(...sources, limit * 5 + 5)
      .all<ExternalItemRow>();

    let scored = (result.results || []).map((row) => ({
      row,
      score: computeExternalScore(
        {
          title: row.title,
          summary: row.summary,
          publishAt: row.publish_at,
          source: row.source,
        },
        asOf,
      ),
    }));

    if (cursorScore !== null && cursorPublishAt && cursorId) {
      scored = scored.filter(
        (s) =>
          s.score < cursorScore! ||
          (s.score === cursorScore! && s.row.publish_at < cursorPublishAt!) ||
          (s.score === cursorScore! && s.row.publish_at === cursorPublishAt! && s.row.id < cursorId!),
      );
    }

    scored.sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      const time = b.row.publish_at.localeCompare(a.row.publish_at);
      if (time !== 0) return time;
      return b.row.id.localeCompare(a.row.id);
    });

    const page = scored.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      scored.length > limit && last ? `${last.score},${last.row.publish_at},${last.row.id},${asOf}` : null;

    const responseData = { items: page.map((s) => toItem(s.row, s.score)), next_cursor: nextCursor };
    if (page.length > 0) {
      await kvCacheSet(c, cacheKey, responseData, 60);
    }
    return c.json(responseData, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (error: unknown) {
    console.error('External feed error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default externalFeed;
