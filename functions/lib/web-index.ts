import type { CrowdWebhookEvent } from '@flaxia/sdk';
import { extractCallbackOutput } from '@flaxia/sdk';
import type { CrowdEnv } from './crowd';
import { buildFtsMatch, buildLikePattern, type ParsedSearchQuery, searchTextTerms } from './search-query.ts';
import type { WebSearchResult } from './search-web.ts';

/** Minimal shape of a `cc-extract` callback result (the SDK version is decoupled). */
interface CcExtractDocument {
  url: string;
  finalUrl?: string;
  canonicalUrl?: string;
  title: string;
  text: string;
  excerpt: string;
  lang?: string;
  publishedAt?: string;
  contentType: string;
  httpStatus: number;
  warcFilename: string;
  offset: number;
  length: number;
  truncated: boolean;
  error?: string;
}

interface CcExtractOutput {
  documents?: CcExtractDocument[];
}

interface EmbedGemmaOutput {
  vectors?: number[][];
}

interface WebDocumentSearchRow {
  id: string;
  url: string;
  domain: string;
  title: string;
  excerpt: string;
  published_at: string | null;
}

interface CcQueueRow {
  id: string;
  crawl: string;
  title?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replaceAll('\u0000', '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sitePattern(site: string): string | null {
  const host = site
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    ?.replace(/^www\./, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

async function markCcTaskFailed(db: D1Database, taskId: string, message: string, onlySubmitted = false): Promise<void> {
  const suffix = onlySubmitted ? " AND status = 'submitted'" : '';
  await db
    .prepare(`UPDATE cc_queue SET status = 'failed', error = ?, updated_at = ? WHERE task_id = ?${suffix}`)
    .bind(message.slice(0, 300), nowIso(), taskId)
    .run();
}

/**
 * Apply a completed `cc-extract` callback: persist the extracted document,
 * queue it for embedding, and settle the corresponding CDX queue row.
 */
export async function handleCcExtractResult(event: CrowdWebhookEvent, db: D1Database, env: CrowdEnv): Promise<void> {
  const output = extractCallbackOutput(event) as CcExtractOutput | undefined;
  const documents = Array.isArray(output?.documents) ? output.documents : [];
  if (documents.length === 0) {
    await markCcTaskFailed(db, event.taskId, 'empty_result', true);
    return;
  }

  for (const document of documents) {
    const row = (await db
      .prepare(
        `SELECT id, crawl FROM cc_queue
         WHERE task_id = ? AND warc_filename = ? AND offset = ? AND length = ?
         LIMIT 1`,
      )
      .bind(event.taskId, document.warcFilename, document.offset, document.length)
      .first<CcQueueRow>()) as CcQueueRow | null;
    if (!row) continue; // A stale callback for a record we no longer track.

    if (document.error) {
      await db
        .prepare(`UPDATE cc_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .bind(document.error.slice(0, 300), nowIso(), row.id)
        .run();
      continue;
    }

    const canonical = validHttpUrl(document.canonicalUrl || document.finalUrl || document.url);
    if (!canonical) {
      await db
        .prepare(`UPDATE cc_queue SET status = 'failed', error = 'invalid_url', updated_at = ? WHERE id = ?`)
        .bind(nowIso(), row.id)
        .run();
      continue;
    }

    const id = await sha256Hex(canonical.toString());
    const domain = canonical.hostname.toLowerCase();
    const text = cleanText(document.text, 64_000);
    const excerpt = cleanText(document.excerpt || text, 400);
    const title = cleanText(document.title, 300) || canonical.toString();
    let r2Key: string | null = null;
    if (env.BUCKET && text) {
      r2Key = `web/${id}.txt`;
      try {
        await env.BUCKET.put(r2Key, text);
      } catch (error) {
        console.error(`Failed to store web document ${id} in R2:`, error);
        r2Key = null;
      }
    }

    await db
      .prepare(
        `INSERT INTO web_documents
           (id, url, canonical_url, domain, lang, title, excerpt, r2_key, published_at, crawl, status, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
         ON CONFLICT(id) DO UPDATE SET
           url = excluded.url,
           canonical_url = excluded.canonical_url,
           domain = excluded.domain,
           lang = excluded.lang,
           title = excluded.title,
           excerpt = excluded.excerpt,
           r2_key = excluded.r2_key,
           published_at = excluded.published_at,
           crawl = excluded.crawl,
           status = 'active',
           fetched_at = excluded.fetched_at,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(
        id,
        canonical.toString(),
        canonical.toString(),
        domain,
        document.lang?.slice(0, 16) ?? null,
        title,
        excerpt,
        r2Key,
        document.publishedAt?.slice(0, 40) ?? null,
        row.crawl,
        nowIso(),
      )
      .run();

    if (env.WEB_EMBEDDINGS_ENABLED === '1') {
      await db
        .prepare(
          `INSERT INTO embed_queue (doc_id, status, task_id, error, updated_at)
           VALUES (?, 'pending', NULL, NULL, ?)
           ON CONFLICT(doc_id) DO UPDATE SET
             status = 'pending',
             task_id = NULL,
             error = NULL,
             updated_at = excluded.updated_at`,
        )
        .bind(id, nowIso())
        .run();
    }

    await db
      .prepare(`UPDATE cc_queue SET status = 'done', error = NULL, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), row.id)
      .run();
  }
}

/** Mark a failed `cc-extract` or `embed-gemma` task in the corresponding queue. */
export async function handleWebIndexTaskFailure(
  callbackType: string | null,
  event: CrowdWebhookEvent,
  db: D1Database,
): Promise<void> {
  const error = (event.error || 'task_failed').slice(0, 300);
  if (callbackType === 'cc-extract') {
    await markCcTaskFailed(db, event.taskId, error);
  } else if (callbackType === 'embed-gemma') {
    await db
      .prepare(
        `UPDATE embed_queue SET status = 'failed', error = ?, updated_at = ?
         WHERE task_id = ? AND status = 'submitted'`,
      )
      .bind(error, nowIso(), event.taskId)
      .run();
  }
}

/** Persist EmbeddingGemma 2 vectors for the documents named in the callback URL. */
export async function handleEmbedGemmaResult(
  url: URL,
  event: CrowdWebhookEvent,
  db: D1Database,
  env: CrowdEnv,
): Promise<void> {
  const docIds = (url.searchParams.get('docs') || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (docIds.length === 0 || docIds.length > 32) {
    await db
      .prepare(`UPDATE embed_queue SET status = 'failed', error = 'invalid_docs', updated_at = ? WHERE task_id = ?`)
      .bind(nowIso(), event.taskId)
      .run();
    return;
  }

  const output = extractCallbackOutput(event) as EmbedGemmaOutput | undefined;
  const vectors = Array.isArray(output?.vectors) ? output.vectors : [];
  const dimensions = vectors[0]?.length ?? 0;
  if (
    vectors.length !== docIds.length ||
    dimensions < 128 ||
    !vectors.every((vector) => Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite))
  ) {
    await db
      .prepare(`UPDATE embed_queue SET status = 'failed', error = 'invalid_vectors', updated_at = ? WHERE task_id = ?`)
      .bind(nowIso(), event.taskId)
      .run();
    return;
  }

  const placeholders = docIds.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, domain, lang FROM web_documents WHERE id IN (${placeholders})`)
    .bind(...docIds)
    .all<{ id: string; domain: string; lang: string | null }>();
  const byId = new Map((rows.results || []).map((row) => [row.id, row]));

  const vectorIndex = env.VECTORIZE_WEB;
  if (!vectorIndex) {
    await db
      .prepare(
        `UPDATE embed_queue SET status = 'failed', error = 'vectorize_web_unavailable', updated_at = ? WHERE task_id = ?`,
      )
      .bind(nowIso(), event.taskId)
      .run();
    return;
  }

  await vectorIndex.upsert(
    docIds.map((id, index) => {
      const row = byId.get(id);
      return {
        id,
        values: vectors[index]!,
        metadata: { kind: 'web', domain: row?.domain ?? '', lang: row?.lang ?? '' },
      };
    }),
  );

  for (const id of docIds) {
    if (!byId.has(id)) continue;
    await db
      .prepare(`UPDATE embed_queue SET status = 'done', error = NULL, updated_at = ? WHERE doc_id = ?`)
      .bind(nowIso(), id)
      .run();
  }
}

/**
 * Lexical search over the Common Crawl web index. Vector search (when enabled)
 * is merged by the caller; this function intentionally has no Crowd dependency.
 */
export async function searchWebIndex(
  db: D1Database,
  parsed: ParsedSearchQuery,
  limit: number,
): Promise<WebSearchResult[]> {
  if (limit <= 0) return [];
  const terms = searchTextTerms(parsed);
  if (terms.length === 0) return [];

  const fts = buildFtsMatch(parsed);
  const where: string[] = ["d.status = 'active'"];
  const params: Array<string | number> = [];

  if (fts) {
    where.push('web_fts MATCH ?');
    params.push(fts);
  } else {
    for (const term of terms) {
      where.push("(d.title LIKE ? ESCAPE '\\' OR d.excerpt LIKE ? ESCAPE '\\')");
      const pattern = buildLikePattern(term);
      params.push(pattern, pattern);
    }
  }

  for (const site of parsed.sites) {
    const host = sitePattern(site);
    if (!host) continue;
    where.push('(d.domain = ? OR d.domain LIKE ?)');
    params.push(host, `%.${host}`);
  }

  const join = fts ? 'JOIN web_fts ON web_fts.rowid = d.rowid' : '';
  const order = fts ? 'bm25(web_fts) ASC, d.fetched_at DESC' : 'd.fetched_at DESC';

  const result = await db
    .prepare(
      `SELECT d.id, d.url, d.domain, d.title, d.excerpt, d.published_at
       FROM web_documents d
       ${join}
       WHERE ${where.join(' AND ')}
       ORDER BY ${order}
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<WebDocumentSearchRow>();

  return (result.results || []).map((row) => ({
    title: row.title || row.url,
    url: row.url,
    snippet: row.excerpt,
    source: row.domain || 'Web',
    published_at: row.published_at || undefined,
  }));
}
