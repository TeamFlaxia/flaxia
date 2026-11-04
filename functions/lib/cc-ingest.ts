import { createCcRangeUrl, isValidWarcPath, MAX_CC_RECORD_BYTES } from './cc-range.ts';
import type { CrowdConfig, CrowdEnv } from './crowd.ts';
import { crowdConfig, getCrowdClient, signedCallbackUrl } from './crowd.ts';
import { sha256Hex } from './sha256.ts';

/**
 * Scheduled Common Crawl ingestion.
 *
 * The CDX index tells us where each page lives inside the WARC corpus. A small
 * number of `cc-extract` tasks are submitted per run so the volunteer queue is
 * not flooded; extracted documents are then queued for EmbeddingGemma 2.
 */

const CDX_LIMIT_PER_DOMAIN = 25;
const CC_TASKS_PER_RUN = 8;
const CC_RECORDS_PER_TASK = 3;
const EMBED_TASKS_PER_RUN = 4;
const EMBED_DOCS_PER_TASK = 16;
const EMBED_DIMENSIONS = 512;
const MAX_CC_ATTEMPTS = 5;
// Rows stuck in 'submitted' lose their task: the callback never arrives (the
// node dies, the orchestrator loses the task, or the signed fetch URL expires
// before the node picks the task up). Requeue them after this window so the
// record gets another chance; once attempts are exhausted the row is failed.
const STALE_SUBMISSION_MS = 2 * 60 * 60 * 1000;
// Keep the literal out of an `expirationTtl:` expression: the security guard
// treats an immediately following integer as the TTL and rejects values < 60.
const LATEST_CRAWL_TTL_SECONDS = 24 * 60 * 60;

export interface CcIngestEnv extends CrowdEnv {
  DB: D1Database;
  BASE_URL: string;
  BUCKET?: R2Bucket;
  CACHE?: KVNamespace;
  /** Explicit crawl id; otherwise the latest crawl is resolved via collinfo. */
  CC_CRAWL?: string;
  /** Comma-separated seed domains when `cc_sources` is empty. */
  CC_DOMAINS?: string;
  WEB_EMBEDDINGS_ENABLED?: string;
}

interface CcQueueRow {
  id: string;
  crawl: string;
  url: string;
  warc_filename: string;
  offset: number;
  length: number;
}

interface CdxRecord {
  url?: unknown;
  filename?: unknown;
  offset?: unknown;
  length?: unknown;
  languages?: unknown;
  digest?: unknown;
}

interface CrowdSubmitter {
  submit(options: {
    workload: string;
    payload: unknown;
    callbackUrl?: string;
    timeoutMs?: number;
  }): Promise<{ taskId: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function submitter(config: CrowdConfig): CrowdSubmitter | null {
  const client = getCrowdClient(config);
  return client ? (client as unknown as CrowdSubmitter) : null;
}

/**
 * Sweep rows that were submitted but never settled. Returns them to `pending`
 * (or fails them once `MAX_CC_ATTEMPTS` is reached) so a lost callback does
 * not strand the record forever. Runs before any submission on every pass.
 */
async function reapStaleSubmissions(db: D1Database): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_SUBMISSION_MS).toISOString();
  let reaped = 0;
  for (const table of ['cc_queue', 'embed_queue'] as const) {
    const result = await db
      .prepare(
        `UPDATE ${table}
         SET status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1,
             error = 'submission_timeout',
             updated_at = ?
         WHERE status = 'submitted' AND updated_at < ?`,
      )
      .bind(MAX_CC_ATTEMPTS, nowIso(), cutoff)
      .run();
    reaped += result.meta.changes ?? 0;
  }
  return reaped;
}

async function latestCrawl(env: CcIngestEnv): Promise<string | null> {
  if (env.CC_CRAWL) return env.CC_CRAWL;
  const cacheKey = 'cc:latest-crawl';
  const cached = await env.CACHE?.get(cacheKey);
  if (cached) return cached;
  try {
    const response = await fetch('https://index.commoncrawl.org/collinfo.json', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Array<{ id?: unknown }>;
    const crawl = data.find((entry) => typeof entry.id === 'string' && entry.id.startsWith('CC-MAIN-'))?.id;
    if (typeof crawl !== 'string') return null;
    await env.CACHE?.put(cacheKey, crawl, { expirationTtl: LATEST_CRAWL_TTL_SECONDS });
    return crawl;
  } catch (error) {
    console.error('Failed to resolve the latest Common Crawl:', error);
    return null;
  }
}

async function seedSources(env: CcIngestEnv): Promise<void> {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS total FROM cc_sources').first<{ total: number }>();
  if ((existing?.total ?? 0) > 0) return;
  const domains = (env.CC_DOMAINS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value));
  for (const domain of domains) {
    await env.DB.prepare('INSERT OR IGNORE INTO cc_sources (domain, enabled) VALUES (?, 1)').bind(domain).run();
  }
}

async function discoverDomain(env: CcIngestEnv, crawl: string, domain: string): Promise<number> {
  const params = new URLSearchParams({
    url: `${domain}/*`,
    output: 'json',
    collapse: 'urlkey',
    limit: String(CDX_LIMIT_PER_DOMAIN),
  });
  // PyWB's CDX server accepts repeated `filter` parameters.
  const endpoint = `https://index.commoncrawl.org/${crawl}-index?${params.toString()}&filter=status:200&filter=mime:text/html`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error(`CDX discovery failed for ${domain}:`, error);
    return 0;
  }
  if (!response.ok) {
    console.error(`CDX discovery returned HTTP ${response.status} for ${domain}`);
    return 0;
  }

  const text = await response.text();
  let inserted = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: CdxRecord;
    try {
      record = JSON.parse(line) as CdxRecord;
    } catch {
      continue;
    }
    const warcFilename = typeof record.filename === 'string' ? record.filename : '';
    const url = typeof record.url === 'string' ? record.url : '';
    const offset = Number(record.offset);
    const length = Number(record.length);
    if (
      !url ||
      !isValidWarcPath(warcFilename) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_CC_RECORD_BYTES
    ) {
      continue;
    }
    const id = await sha256Hex(`${warcFilename}|${offset}|${length}`);
    const result = await env.DB.prepare(
      `INSERT INTO cc_queue
         (id, crawl, url, warc_filename, offset, length, languages, content_digest, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(
        id,
        crawl,
        url,
        warcFilename,
        offset,
        length,
        typeof record.languages === 'string' ? record.languages : null,
        typeof record.digest === 'string' ? record.digest : null,
      )
      .run();
    if (result.meta.changes > 0) inserted += 1;
    if (inserted >= CDX_LIMIT_PER_DOMAIN) break;
  }

  await env.DB.prepare('UPDATE cc_sources SET last_crawled_at = ? WHERE domain = ?').bind(nowIso(), domain).run();
  return inserted;
}

async function submitExtractTasks(env: CcIngestEnv, config: CrowdConfig, client: CrowdSubmitter): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id, crawl, url, warc_filename, offset, length
     FROM cc_queue
     WHERE status = 'pending' AND attempts < ?
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(MAX_CC_ATTEMPTS, CC_TASKS_PER_RUN * CC_RECORDS_PER_TASK)
    .all<CcQueueRow>();
  const rows = pending.results || [];
  if (rows.length === 0) return 0;
  if (!config.webhookSecret) {
    console.error('Crowd webhook secret is not configured; skipping CC ingestion');
    return 0;
  }

  let submitted = 0;
  for (let start = 0; start < rows.length; start += CC_RECORDS_PER_TASK) {
    const batch = rows.slice(start, start + CC_RECORDS_PER_TASK);
    if (batch.length === 0) continue;
    try {
      const records = await Promise.all(
        batch.map(async (row) => ({
          url: row.url,
          warcFilename: row.warc_filename,
          offset: row.offset,
          length: row.length,
          fetchUrl: await createCcRangeUrl(config.webhookSecret, config.baseUrl, {
            warcFilename: row.warc_filename,
            offset: row.offset,
            length: row.length,
          }),
        })),
      );
      const callbackUrl = await signedCallbackUrl(config, {
        baseUrl: config.baseUrl,
        type: 'cc-extract',
      });
      const result = await client.submit({
        workload: 'cc-extract',
        payload: { crawl: batch[0]!.crawl, records },
        callbackUrl,
        timeoutMs: 60_000,
      });
      const placeholders = batch.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE cc_queue
         SET status = 'submitted', task_id = ?, attempts = attempts + 1, error = NULL, updated_at = ?
         WHERE id IN (${placeholders})`,
      )
        .bind(result.taskId, nowIso(), ...batch.map((row) => row.id))
        .run();
      submitted += 1;
    } catch (error) {
      console.error('Failed to submit a cc-extract task:', error);
      const placeholders = batch.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE cc_queue
         SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
             error = ?,
             updated_at = ?
         WHERE id IN (${placeholders})`,
      )
        .bind(
          MAX_CC_ATTEMPTS,
          error instanceof Error ? error.message.slice(0, 300) : 'submit_failed',
          nowIso(),
          ...batch.map((row) => row.id),
        )
        .run();
    }
  }
  return submitted;
}

async function submitEmbeddingTasks(env: CcIngestEnv, config: CrowdConfig, client: CrowdSubmitter): Promise<number> {
  // Without a dedicated vector index every submitted task is guaranteed to
  // come back as a no-op failure; skip submission until the operator creates
  // VECTORIZE_WEB (see docs/web-index.md).
  if (env.WEB_EMBEDDINGS_ENABLED !== '1' || !env.BUCKET || !env.VECTORIZE_WEB) return 0;
  const pending = await env.DB.prepare(
    `SELECT e.doc_id, d.title, d.r2_key
     FROM embed_queue e
     JOIN web_documents d ON d.id = e.doc_id
     WHERE e.status = 'pending' AND e.attempts < ?
     ORDER BY e.created_at ASC
     LIMIT ?`,
  )
    .bind(MAX_CC_ATTEMPTS, EMBED_TASKS_PER_RUN * EMBED_DOCS_PER_TASK)
    .all<{ doc_id: string; title: string; r2_key: string | null }>();
  const rows = pending.results || [];
  if (rows.length === 0) return 0;
  if (!config.webhookSecret) return 0;

  let submitted = 0;
  for (let start = 0; start < rows.length; start += EMBED_DOCS_PER_TASK) {
    const batch = rows.slice(start, start + EMBED_DOCS_PER_TASK);
    const texts: string[] = [];
    const docIds: string[] = [];
    for (const row of batch) {
      if (!row.r2_key) {
        await env.DB.prepare(
          `UPDATE embed_queue SET status = 'failed', error = 'missing_text', updated_at = ? WHERE doc_id = ?`,
        )
          .bind(nowIso(), row.doc_id)
          .run();
        continue;
      }
      const object = await env.BUCKET.get(row.r2_key);
      if (!object) {
        await env.DB.prepare(
          `UPDATE embed_queue SET status = 'failed', error = 'missing_text_object', updated_at = ? WHERE doc_id = ?`,
        )
          .bind(nowIso(), row.doc_id)
          .run();
        continue;
      }
      const text = (await object.text()).slice(0, 3_600);
      if (!text) {
        await env.DB.prepare(
          `UPDATE embed_queue SET status = 'failed', error = 'empty_text', updated_at = ? WHERE doc_id = ?`,
        )
          .bind(nowIso(), row.doc_id)
          .run();
        continue;
      }
      texts.push(`title: ${row.title || 'none'} | text: ${text}`);
      docIds.push(row.doc_id);
    }
    if (texts.length === 0) continue;
    try {
      const callbackUrl = await signedCallbackUrl(config, {
        baseUrl: config.baseUrl,
        type: 'embed-gemma',
        params: { docs: docIds.join(','), dims: EMBED_DIMENSIONS },
      });
      const result = await client.submit({
        workload: 'embed-gemma',
        payload: { texts, dimensions: EMBED_DIMENSIONS },
        callbackUrl,
        timeoutMs: 120_000,
      });
      const placeholders = docIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE embed_queue
         SET status = 'submitted', task_id = ?, attempts = attempts + 1, error = NULL, updated_at = ?
         WHERE doc_id IN (${placeholders})`,
      )
        .bind(result.taskId, nowIso(), ...docIds)
        .run();
      submitted += 1;
    } catch (error) {
      console.error('Failed to submit an embed-gemma task:', error);
      const placeholders = docIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE embed_queue
         SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
             error = ?,
             updated_at = ?
         WHERE doc_id IN (${placeholders})`,
      )
        .bind(
          MAX_CC_ATTEMPTS,
          error instanceof Error ? error.message.slice(0, 300) : 'submit_failed',
          nowIso(),
          ...docIds,
        )
        .run();
    }
  }
  return submitted;
}

/** Hourly entry point. Submits a bounded amount of work and returns silently. */
export async function drainCcIngestion(env: CcIngestEnv): Promise<void> {
  try {
    const reaped = await reapStaleSubmissions(env.DB);
    if (reaped > 0) console.log(`Requeued ${reaped} stale submission(s)`);
  } catch (error) {
    console.error('Stale submission sweep failed:', error);
  }

  const config = crowdConfig(env);
  if (!config.configured) return;
  const client = submitter(config);
  if (!client) return;

  const crawl = await latestCrawl(env);
  if (!crawl) return;
  await seedSources(env);

  const sources = await env.DB.prepare(
    `SELECT domain FROM cc_sources
     WHERE enabled = 1
     ORDER BY last_crawled_at IS NOT NULL, last_crawled_at ASC
     LIMIT 2`,
  ).all<{ domain: string }>();
  for (const source of sources.results || []) {
    await discoverDomain(env, crawl, source.domain);
  }

  await submitExtractTasks(env, config, client);
  await submitEmbeddingTasks(env, config, client);
}
