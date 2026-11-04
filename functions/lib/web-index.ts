import type { CrowdWebhookEvent } from '@flaxia/sdk';
import { extractCallbackOutput } from '@flaxia/sdk';
import type { CrowdEnv, VectorizeLike } from './crowd';
import { buildFtsMatch, buildLikePattern, type ParsedSearchQuery, searchTextTerms } from './search-query.ts';
import type { WebSearchResult } from './search-web.ts';
import { sha256Hex } from './sha256.ts';

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
  content_digest?: string | null;
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

const MAX_EXTRACT_DOCUMENTS = 16;
const EMBED_DIMS_FLOOR = 128;

function isIndexableDocument(document: CcExtractDocument): boolean {
  const status = Number(document.httpStatus);
  if (!Number.isFinite(status) || status < 200 || status >= 300) return false;
  const contentType = (typeof document.contentType === 'string' ? document.contentType : '').toLowerCase();
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
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
  const documents = Array.isArray(output?.documents) ? output.documents.slice(0, MAX_EXTRACT_DOCUMENTS) : [];
  if (documents.length === 0) {
    await markCcTaskFailed(db, event.taskId, 'empty_result', true);
    return;
  }

  for (const document of documents) {
    const row = (await db
      .prepare(
        `SELECT id, crawl, content_digest FROM cc_queue
         WHERE task_id = ? AND warc_filename = ? AND offset = ? AND length = ? AND status = 'submitted'
         LIMIT 1`,
      )
      .bind(event.taskId, document.warcFilename, document.offset, document.length)
      .first<CcQueueRow>()) as CcQueueRow | null;
    if (!row) continue; // A stale callback for a record we no longer track.

    if (document.error) {
      await db
        .prepare(
          `UPDATE cc_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'submitted'`,
        )
        .bind(document.error.slice(0, 300), nowIso(), row.id)
        .run();
      continue;
    }

    if (!isIndexableDocument(document)) {
      await db
        .prepare(
          `UPDATE cc_queue SET status = 'failed', error = 'not_indexable', updated_at = ? WHERE id = ? AND status = 'submitted'`,
        )
        .bind(nowIso(), row.id)
        .run();
      continue;
    }

    const canonical = validHttpUrl(document.canonicalUrl || document.finalUrl || document.url);
    if (!canonical) {
      await db
        .prepare(
          `UPDATE cc_queue SET status = 'failed', error = 'invalid_url', updated_at = ? WHERE id = ? AND status = 'submitted'`,
        )
        .bind(nowIso(), row.id)
        .run();
      continue;
    }

    const id = await sha256Hex(canonical.toString());
    const domain = canonical.hostname.toLowerCase();
    // Content-based dedup: a re-crawl whose CDX digest matches the stored
    // `content_sha` leaves the document, its FTS entry and its embedding
    // untouched — only freshness is updated. Digests come from the CDX index;
    // they identify the source record, not the extracted text.
    const contentSha =
      typeof row.content_digest === 'string' && row.content_digest.length > 0 ? row.content_digest : null;
    if (contentSha) {
      const previous = await db
        .prepare(`SELECT content_sha, status FROM web_documents WHERE id = ?`)
        .bind(id)
        .first<{ content_sha: string | null; status: string }>();
      if (previous && previous.status === 'active' && previous.content_sha === contentSha) {
        await db
          .prepare(
            `UPDATE web_documents SET fetched_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
          )
          .bind(nowIso(), id)
          .run();
        await db
          .prepare(
            `UPDATE cc_queue SET status = 'done', error = NULL, updated_at = ? WHERE id = ? AND status = 'submitted'`,
          )
          .bind(nowIso(), row.id)
          .run();
        continue;
      }
    }

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
           (id, url, canonical_url, domain, lang, title, excerpt, r2_key, published_at, crawl, content_sha, status, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
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
           content_sha = COALESCE(excluded.content_sha, web_documents.content_sha),
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
        contentSha,
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
      .prepare(
        `UPDATE cc_queue SET status = 'done', error = NULL, updated_at = ? WHERE id = ? AND status = 'submitted'`,
      )
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
    // Only rows the callback is still accountable for; never overwrite a row
    // the task already settled as done.
    await markCcTaskFailed(db, event.taskId, error, true);
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
  const markTaskFailed = async (message: string): Promise<void> => {
    await db
      .prepare(
        `UPDATE embed_queue SET status = 'failed', error = ?, updated_at = ? WHERE task_id = ? AND status = 'submitted'`,
      )
      .bind(message.slice(0, 300), nowIso(), event.taskId)
      .run();
  };

  const docIds = (url.searchParams.get('docs') || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (docIds.length === 0 || docIds.length > 32) {
    await markTaskFailed('invalid_docs');
    return;
  }

  const output = extractCallbackOutput(event) as EmbedGemmaOutput | undefined;
  const vectors = Array.isArray(output?.vectors) ? output.vectors : [];
  const dimensions = vectors[0]?.length ?? 0;
  if (
    vectors.length !== docIds.length ||
    dimensions < EMBED_DIMS_FLOOR ||
    !vectors.every((vector) => Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite))
  ) {
    await markTaskFailed('invalid_vectors');
    return;
  }

  // The callback URL carries the expected dimensionality; refuse to upsert a
  // vector set that does not match it rather than 500 into a retry loop.
  const expectedDims = Number(url.searchParams.get('dims'));
  if (Number.isFinite(expectedDims) && expectedDims > 0 && expectedDims !== dimensions) {
    await markTaskFailed('dimensions_mismatch');
    return;
  }

  const placeholders = docIds.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, domain, lang FROM web_documents WHERE id IN (${placeholders})`)
    .bind(...docIds)
    .all<{ id: string; domain: string; lang: string | null }>();
  const byId = new Map((rows.results || []).map((row) => [row.id, row]));

  // Embedding a document we no longer hold is pointless; fail it loudly and
  // keep the vector index free of orphans.
  const present: Array<{ id: string; index: number }> = [];
  const missing: string[] = [];
  for (let index = 0; index < docIds.length; index++) {
    const id = docIds[index]!;
    if (byId.has(id)) present.push({ id, index });
    else missing.push(id);
  }
  if (missing.length > 0) {
    const missingPlaceholders = missing.map(() => '?').join(',');
    await db
      .prepare(
        `UPDATE embed_queue SET status = 'failed', error = 'document_missing', updated_at = ? WHERE doc_id IN (${missingPlaceholders}) AND status = 'submitted'`,
      )
      .bind(nowIso(), ...missing)
      .run();
  }
  if (present.length === 0) return;

  const vectorIndex = env.VECTORIZE_WEB;
  if (!vectorIndex) {
    const presentPlaceholders = present.map(() => '?').join(',');
    await db
      .prepare(
        `UPDATE embed_queue SET status = 'failed', error = 'vectorize_web_unavailable', updated_at = ? WHERE doc_id IN (${presentPlaceholders}) AND status = 'submitted'`,
      )
      .bind(nowIso(), ...present.map((entry) => entry.id))
      .run();
    return;
  }

  try {
    await vectorIndex.upsert(
      present.map(({ id, index }) => {
        const row = byId.get(id)!;
        return {
          id,
          values: vectors[index]!,
          metadata: { kind: 'web', domain: row.domain, lang: row.lang ?? '' },
        };
      }),
    );
  } catch (error) {
    console.error('VECTORIZE_WEB upsert failed:', error);
    const presentPlaceholders = present.map(() => '?').join(',');
    await db
      .prepare(
        `UPDATE embed_queue SET status = 'failed', error = 'upsert_failed', updated_at = ? WHERE doc_id IN (${presentPlaceholders}) AND status = 'submitted'`,
      )
      .bind(nowIso(), ...present.map((entry) => entry.id))
      .run();
    return;
  }

  for (const { id } of present) {
    await db
      .prepare(
        `UPDATE embed_queue SET status = 'done', error = NULL, updated_at = ? WHERE doc_id = ? AND status = 'submitted'`,
      )
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

  // Multiple `site:` filters are a union, matching the external web providers.
  const siteClauses: string[] = [];
  for (const site of parsed.sites) {
    const host = sitePattern(site);
    if (!host) continue;
    siteClauses.push('(d.domain = ? OR d.domain LIKE ?)');
    params.push(host, `%.${host}`);
  }
  if (siteClauses.length === 1) {
    where.push(siteClauses[0]!);
  } else if (siteClauses.length > 1) {
    where.push(`(${siteClauses.join(' OR ')})`);
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

/**
 * Retention for the web index.
 *
 * Documents that have not been re-fetched in `WEB_DOC_STALE_AFTER_MS` are
 * marked `stale` (excluded from search) and hard-deleted after
 * `WEB_DOC_DELETE_AFTER_MS` together with their R2 text object, their
 * `embed_queue` row and their Vectorize vector. Terminal queue rows are
 * purged after `TERMINAL_QUEUE_PURGE_AFTER_MS`. All timestamps are ISO-8601
 * strings, so lexicographic comparison matches chronological order.
 */
const WEB_DOC_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const WEB_DOC_DELETE_AFTER_MS = 120 * 24 * 60 * 60 * 1000;
const TERMINAL_QUEUE_PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const WEB_DOC_DELETE_BATCH = 200;

export interface WebRetentionEnv {
  BUCKET?: R2Bucket;
  VECTORIZE_WEB?: VectorizeLike;
}

export interface WebRetentionResult {
  staled: number;
  deleted: number;
  purgedCcQueue: number;
  purgedEmbedQueue: number;
}

export async function reapWebDocuments(
  db: D1Database,
  env: WebRetentionEnv,
  now = Date.now(),
): Promise<WebRetentionResult> {
  const nowIsoValue = new Date(now).toISOString();
  const staleCutoff = new Date(now - WEB_DOC_STALE_AFTER_MS).toISOString();
  const deleteCutoff = new Date(now - WEB_DOC_DELETE_AFTER_MS).toISOString();
  const purgeCutoff = new Date(now - TERMINAL_QUEUE_PURGE_AFTER_MS).toISOString();

  const staledResult = await db
    .prepare(`UPDATE web_documents SET status = 'stale', updated_at = ? WHERE status = 'active' AND fetched_at < ?`)
    .bind(nowIsoValue, staleCutoff)
    .run();

  const doomed = await db
    .prepare(`SELECT id, r2_key FROM web_documents WHERE status = 'stale' AND fetched_at < ? LIMIT ?`)
    .bind(deleteCutoff, WEB_DOC_DELETE_BATCH)
    .all<{ id: string; r2_key: string | null }>();
  const doomedRows = doomed.results ?? [];

  const doomedIds: string[] = [];
  for (const doc of doomedRows) {
    if (doc.r2_key) {
      if (env.BUCKET) {
        try {
          await env.BUCKET.delete(doc.r2_key);
        } catch (error) {
          // Keep the row so the next pass can retry the cleanup rather than
          // orphaning the R2 object and losing the handle to it.
          console.error(`Failed to delete R2 object ${doc.r2_key}; keeping the document row:`, error);
          continue;
        }
      } else {
        console.warn(`BUCKET binding is missing; deleting the document row for ${doc.id} and leaving its R2 object`);
      }
    }
    doomedIds.push(doc.id);
  }

  let deleted = 0;
  if (doomedIds.length > 0) {
    if (env.VECTORIZE_WEB?.deleteByIds) {
      try {
        await env.VECTORIZE_WEB.deleteByIds(doomedIds);
      } catch (error) {
        // The vector index tolerates orphans; retry is best-effort.
        console.error('Failed to delete web vectors for stale documents:', error);
      }
    }
    const placeholders = doomedIds.map(() => '?').join(',');
    await db
      .prepare(`DELETE FROM embed_queue WHERE doc_id IN (${placeholders})`)
      .bind(...doomedIds)
      .run();
    const deleteResult = await db
      .prepare(`DELETE FROM web_documents WHERE id IN (${placeholders}) AND status = 'stale'`)
      .bind(...doomedIds)
      .run();
    deleted = deleteResult.meta.changes ?? 0;
  }

  const purgedCc = await db
    .prepare(`DELETE FROM cc_queue WHERE status IN ('done', 'failed', 'skipped') AND updated_at < ?`)
    .bind(purgeCutoff)
    .run();
  const purgedEmbed = await db
    .prepare(`DELETE FROM embed_queue WHERE status IN ('done', 'failed') AND updated_at < ?`)
    .bind(purgeCutoff)
    .run();

  return {
    staled: staledResult.meta.changes ?? 0,
    deleted,
    purgedCcQueue: purgedCc.meta.changes ?? 0,
    purgedEmbedQueue: purgedEmbed.meta.changes ?? 0,
  };
}
