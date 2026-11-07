import { fetchWithSsrfGuard, parsePublicHttpUrl } from './url-guard.ts';

export type ExternalSource = 'arxiv' | 'hackernews';

export const EXTERNAL_SOURCES: readonly ExternalSource[] = ['arxiv', 'hackernews'] as const;

export interface ExternalItemInput {
  source: ExternalSource;
  externalId: string;
  title: string;
  summary: string;
  url: string;
  author: string;
  tags: string[];
  publishAt: string;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlEntities(match[1].trim()) : '';
}

function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeXmlEntities(m[1].trim()));
  }
  return out;
}

/** Parse an arXiv Atom feed into normalized items. Pure; unit-testable. */
export function parseArxivAtom(xml: string): ExternalItemInput[] {
  const items: ExternalItemInput[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(xml)) !== null) {
    const body = entry[1];
    const idUrl = xmlTag(body, 'id');
    const externalId = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
    const title = xmlTag(body, 'title').replace(/\s+/g, ' ');
    const summary = xmlTag(body, 'summary').replace(/\s+/g, ' ');
    const publishAt = xmlTag(body, 'published');
    const author = xmlTag(body, 'name');
    let url = '';
    const linkRe = /<link[^>]*href="([^"]+)"[^>]*\/?>/g;
    let link: RegExpExecArray | null;
    while ((link = linkRe.exec(body)) !== null) {
      if (link[0].includes('rel="alternate"') || !link[0].includes('rel=')) {
        url = link[1];
        break;
      }
    }
    if (!url) url = idUrl;
    const tags = [
      ...xmlAll(body, 'category').filter(Boolean),
      ...Array.from(body.matchAll(/<category[^>]*term="([^"]+)"/g)).map((m) => m[1]),
    ];
    if (!externalId || !title || !publishAt || !url) continue;
    items.push({ source: 'arxiv', externalId, title, summary, url, author, tags, publishAt });
  }
  return items;
}

/** Parse an HN Algolia search_by_date payload into normalized items. Pure. */
export function parseHackerNewsAlgolia(payload: unknown): ExternalItemInput[] {
  const hits = (payload as { hits?: unknown[] } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  const items: ExternalItemInput[] = [];
  for (const raw of hits) {
    if (!raw || typeof raw !== 'object') continue;
    const hit = raw as Record<string, unknown>;
    const objectID = typeof hit.objectID === 'string' || typeof hit.objectID === 'number' ? String(hit.objectID) : '';
    const title = typeof hit.title === 'string' ? hit.title.trim() : '';
    const createdAt = typeof hit.created_at === 'string' ? hit.created_at : '';
    if (!objectID || !title || !createdAt) continue;
    const fallbackUrl = `https://news.ycombinator.com/item?id=${objectID}`;
    const url = typeof hit.url === 'string' && hit.url ? hit.url : fallbackUrl;
    const author = typeof hit.author === 'string' ? hit.author : '';
    const tags = Array.isArray(hit._tags) ? hit._tags.filter((t): t is string => typeof t === 'string') : [];
    items.push({
      source: 'hackernews',
      externalId: objectID,
      title,
      summary: '',
      url,
      author,
      tags,
      publishAt: createdAt,
    });
  }
  return items;
}

function isValidPublicUrl(raw: string): boolean {
  try {
    parsePublicHttpUrl(raw);
    return true;
  } catch {
    return false;
  }
}

async function upsertItems(db: D1Database, items: ExternalItemInput[]): Promise<number> {
  const valid = items.filter((item) => isValidPublicUrl(item.url));
  if (valid.length === 0) return 0;
  const statements = valid.map((item) =>
    db
      .prepare(
        `INSERT INTO external_items (id, source, external_id, title, summary, url, author, tags, publish_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, external_id) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           url = excluded.url,
           author = excluded.author,
           tags = excluded.tags,
           publish_at = excluded.publish_at,
           fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(
        crypto.randomUUID(),
        item.source,
        item.externalId,
        item.title.slice(0, 500),
        item.summary.slice(0, 2000),
        item.url,
        item.author.slice(0, 200),
        JSON.stringify(item.tags.slice(0, 20)),
        item.publishAt,
      ),
  );
  await db.batch(statements);
  return valid.length;
}

async function refreshSource(db: D1Database, source: ExternalSource, feedUrl: string): Promise<number> {
  const response = await fetchWithSsrfGuard(feedUrl, { timeoutMs: 15000 });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const items = source === 'arxiv' ? parseArxivAtom(text) : parseHackerNewsAlgolia(JSON.parse(text));
  return upsertItems(db, items);
}

export async function refreshExternalFeed(env: { DB: D1Database }): Promise<{ arxiv: number; hackernews: number }> {
  const result: { arxiv: number; hackernews: number } = { arxiv: 0, hackernews: 0 };
  const sources = await env.DB.prepare('SELECT source, feed_url FROM external_sources WHERE enabled = 1').all<{
    source: string;
    feed_url: string;
  }>();
  for (const row of sources.results ?? []) {
    if (row.source !== 'arxiv' && row.source !== 'hackernews') continue;
    const source = row.source as ExternalSource;
    try {
      result[source] = await refreshSource(env.DB, source, row.feed_url);
      await env.DB.prepare(
        `UPDATE external_sources SET last_fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_status = 200 WHERE source = ?`,
      )
        .bind(source)
        .run();
    } catch (error) {
      console.error(`External feed refresh failed for ${source}:`, (error as Error).message);
      await env.DB.prepare(
        `UPDATE external_sources SET last_fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_status = 500 WHERE source = ?`,
      )
        .bind(source)
        .run();
    }
  }
  await env.DB.prepare(
    `DELETE FROM external_items WHERE publish_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`,
  ).run();
  return result;
}
