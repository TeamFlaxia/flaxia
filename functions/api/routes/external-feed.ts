import { Hono } from 'hono';
import { clampLimit } from '../../lib/pagination';
import { kvCacheGet, kvCacheSet, makeCacheKey } from '../helpers';
import type { Bindings, Variables } from '../types';

const externalFeed = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const ALLOWED_SOURCES = new Set(['all', 'arxiv', 'hackernews']);

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
    const cached = await kvCacheGet<{ items: ReturnType<typeof toItem>[]; next_cursor: string | null }>(c, cacheKey);
    if (cached) {
      return c.json(cached, 200, { 'Cache-Control': 'public, max-age=60' });
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
    await kvCacheSet(c, cacheKey, responseData, 60);
    return c.json(responseData, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (error: unknown) {
    console.error('External feed error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default externalFeed;
