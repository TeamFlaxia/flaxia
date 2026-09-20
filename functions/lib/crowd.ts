// Single adapter between Flaxia and the Flaxia Crowd orchestrator.
//
// Everything that knows about Crowd lives here: client construction, callback
// URL shapes, workload names, webhook dispatch and the D1 side-effects of a
// completed task. Route handlers only import from this module so the Crowd
// protocol surface stays in one place and the two projects can evolve
// independently through `@flaxia/sdk`.
import {
  buildCallbackUrl,
  type CrowdWebhookEvent,
  callbackTypeFromUrl,
  DEFAULT_WORKLOAD_TIMEOUT_MS,
  extractCallbackOutput,
  FlaxiaClient,
  type NudeNetDetection,
  parseCrowdWebhook,
  resolveNsfwTags,
} from '@flaxia/sdk';
import { createProjection, parseBanditConfig, projConfigKey, project } from './linucb.ts';

export interface CrowdEnv {
  CROWD_ORCHESTRATOR_URL?: string;
  CROWD_API_KEY?: string;
  BASE_URL?: string;
  CACHE?: KVNamespace;
  VECTORIZE?: VectorizeLike;
}

/** Minimal Vectorize surface used by the vector-embed callback. */
export interface VectorizeLike {
  upsert(vectors: Array<{ id: string; values: number[] }>): Promise<unknown>;
}

export interface CrowdConfig {
  orchestratorUrl: string;
  apiKey: string;
  baseUrl: string;
  configured: boolean;
}

export const IMAGE_KEY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const NSFW_RATE_LIMIT_MS = 10_000;
const EMBED_RATE_LIMIT_MS = 10_000;
const PENDING_EMBED_MAX_ATTEMPTS = 5;

const NSFW_SCAN_SCHEMA = `post_id TEXT PRIMARY KEY, task_id TEXT, status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'done', 'failed')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), scanned_at TEXT`;
const PENDING_EMBEDS_SCHEMA = `post_id TEXT PRIMARY KEY, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_error TEXT`;

// In-flight / rate-limit guards. Kept module-scoped so every route bundled into
// the same Pages Function worker shares one budget.
const nsfwScanPosts = new Set<string>();
const embeddingPosts = new Set<string>();
let lastNsfwSubmitTime = 0;
let lastEmbedTime = 0;

const projectionCache = new Map<string, number[][]>();

/** Resolve Crowd configuration from the Pages/Worker environment. */
export function crowdConfig(env: CrowdEnv): CrowdConfig {
  const orchestratorUrl = (env.CROWD_ORCHESTRATOR_URL || '').replace(/\/+$/, '');
  const apiKey = env.CROWD_API_KEY || '';
  const baseUrl = (env.BASE_URL || 'https://flaxia.app').replace(/\/+$/, '');
  return { orchestratorUrl, apiKey, baseUrl, configured: Boolean(orchestratorUrl && apiKey) };
}

/** Build a client, or null when Crowd is unconfigured (calls become no-ops). */
function getCrowdClient(config: CrowdConfig): FlaxiaClient | null {
  if (!config.configured) return null;
  return new FlaxiaClient({ baseUrl: `${config.orchestratorUrl}/crowd`, apiKey: config.apiKey });
}

// ── Schema bootstrap ──

export async function ensureNsfwScansTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS post_nsfw_scans (${NSFW_SCAN_SCHEMA})`).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_nsfw_scans_status ON post_nsfw_scans(status, created_at)').run();
  } catch (e) {
    console.error('Failed to ensure post_nsfw_scans table:', e);
  }
}

export async function ensurePendingEmbedsTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS pending_embeddings (${PENDING_EMBEDS_SCHEMA})`).run();
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_pending_embeddings_created ON pending_embeddings(created_at)')
      .run();
  } catch (e) {
    console.error('Failed to ensure pending_embeddings table:', e);
  }
}

// ── NSFW screening (NudeNet) ──

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

/**
 * Submit an image post for NudeNet screening. Best-effort: skips when Crowd is
 * unconfigured, when the attachment is not an image, or when rate-limited.
 */
export async function submitDetectNsfw(
  db: D1Database,
  env: CrowdEnv,
  postId: string,
  gifKey: string | null,
): Promise<void> {
  const config = crowdConfig(env);
  if (!config.configured || !gifKey) return;

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

    const client = getCrowdClient(config);
    if (!client) return;

    const callbackUrl = buildCallbackUrl({ baseUrl: config.baseUrl, type: 'nsfw', params: { postId } });
    const res = await client.submit({
      workload: 'nudenet',
      payload: { imageUrl: `${config.baseUrl}/api/images/${gifKey}` },
      callbackUrl,
      timeoutMs: DEFAULT_WORKLOAD_TIMEOUT_MS.nudenet,
    });
    await markNsfwScan(db, postId, 'submitted', res.taskId);
    console.log(`NSFW detection task submitted for post ${postId} (task ${res.taskId})`);
  } catch (err) {
    console.error(`NSFW detection submission failed for post ${postId}:`, err);
  } finally {
    nsfwScanPosts.delete(postId);
  }
}

// ── Vector embeddings ──

export async function enqueuePendingEmbed(
  db: D1Database | undefined,
  postId: string,
  text: string,
  attempts = 0,
  error?: string,
): Promise<void> {
  if (!db) return;
  try {
    await ensurePendingEmbedsTable(db);
    await db
      .prepare(
        `INSERT INTO pending_embeddings (post_id, text, attempts, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(post_id) DO UPDATE SET
           attempts = excluded.attempts,
           last_error = excluded.last_error`,
      )
      .bind(postId, text, attempts, error ?? null)
      .run();
  } catch (e) {
    console.error(`Failed to enqueue pending embed for post ${postId}:`, e);
  }
}

async function submitEmbedTask(config: CrowdConfig, postId: string, text: string): Promise<boolean> {
  const client = getCrowdClient(config);
  if (!client) return false;

  const callbackUrl = buildCallbackUrl({ baseUrl: config.baseUrl, type: 'vector-embed', params: { postId } });
  try {
    await client.submit({
      workload: 'vector-embed',
      payload: { text },
      callbackUrl,
      timeoutMs: DEFAULT_WORKLOAD_TIMEOUT_MS['vector-embed'],
    });
    lastEmbedTime = Date.now();
    console.log(`Embedding task submitted for post ${postId}`);
    return true;
  } catch (err) {
    console.error(`Embedding submission failed for post ${postId}:`, err);
    return false;
  }
}

/**
 * Drain the pending_embeddings outbox. `respectThrottle` keeps the 10s ceiling
 * for real-time traffic; the admin backfill may pass false to make progress on
 * a large backlog. Failed submissions are kept (attempts++) instead of dropped.
 */
export async function drainPendingEmbeds(
  db: D1Database,
  env: CrowdEnv,
  opts: { maxBatch?: number; delayMs?: number; respectThrottle?: boolean } = {},
): Promise<{ submitted: number; remaining: number }> {
  const { maxBatch = 10, delayMs = 0, respectThrottle = true } = opts;
  const config = crowdConfig(env);

  const count = async (): Promise<number> => {
    const { total } = (await db
      .prepare('SELECT COUNT(*) as total FROM pending_embeddings')
      .first<{ total: number }>()) || { total: 0 };
    return total;
  };

  if (!config.configured) return { submitted: 0, remaining: await count() };

  const rows = await db
    .prepare(
      `SELECT post_id, text, attempts FROM pending_embeddings
       WHERE attempts < ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(PENDING_EMBED_MAX_ATTEMPTS, maxBatch)
    .all<{ post_id: string; text: string; attempts: number }>();

  let submitted = 0;
  for (const row of rows.results || []) {
    if (embeddingPosts.has(row.post_id)) continue;
    if (respectThrottle && Date.now() - lastEmbedTime < EMBED_RATE_LIMIT_MS) break;

    const ok = await submitEmbedTask(config, row.post_id, row.text);
    if (ok) {
      await db.prepare('DELETE FROM pending_embeddings WHERE post_id = ?').bind(row.post_id).run();
      submitted++;
    } else {
      await enqueuePendingEmbed(db, row.post_id, row.text, row.attempts + 1, 'submission failed');
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { submitted, remaining: await count() };
}

/**
 * Submit a post for embedding. Falls back to the pending_embeddings outbox when
 * Crowd is unconfigured, throttled or errored, so no post is lost from the
 * recommendation candidate pool.
 */
export async function embedPost(
  db: D1Database | undefined,
  env: CrowdEnv,
  postId: string,
  text: string,
): Promise<void> {
  if (embeddingPosts.has(postId)) return;
  embeddingPosts.add(postId);
  try {
    const config = crowdConfig(env);
    if (!config.configured) {
      await enqueuePendingEmbed(db, postId, text);
      return;
    }

    if (db) {
      await drainPendingEmbeds(db, env).catch((e) => console.error('Pending embed drain failed:', e));
    }

    if (Date.now() - lastEmbedTime < EMBED_RATE_LIMIT_MS) {
      await enqueuePendingEmbed(db, postId, text);
      return;
    }
    const ok = await submitEmbedTask(config, postId, text);
    if (!ok) await enqueuePendingEmbed(db, postId, text, 1, 'submission failed');
  } finally {
    embeddingPosts.delete(postId);
  }
}

// ── Webhook handling ──

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

async function handleNsfwResult(url: URL, event: CrowdWebhookEvent, db: D1Database): Promise<void> {
  const postId = url.searchParams.get('postId');
  const detections = (event.result?.detections as NudeNetDetection[] | undefined) ?? [];
  if (!postId) return;

  const { nsfw, tags } = resolveNsfwTags(detections);
  const applied = await applyNsfwTags(db, postId, tags);
  await db
    .prepare(
      `INSERT INTO post_nsfw_scans (post_id, status, scanned_at) VALUES (?, 'done', ?)
       ON CONFLICT(post_id) DO UPDATE SET status = 'done', scanned_at = excluded.scanned_at`,
    )
    .bind(postId, new Date().toISOString())
    .run();
  console.log(`NSFW webhook for post ${postId}: nsfw=${nsfw}, tags=${tags.join(',') || 'none'}, applied=${applied}`);
}

async function loadBanditConfig(env: CrowdEnv) {
  const cache = env.CACHE;
  if (!cache) return { ...parseBanditConfig(null) };
  try {
    return parseBanditConfig(await cache.get('arcade:bandit:config'));
  } catch {
    return { ...parseBanditConfig(null) };
  }
}

function getProjection(config: ReturnType<typeof parseBanditConfig>): number[][] {
  const key = projConfigKey(config);
  let projection = projectionCache.get(key);
  if (!projection) {
    projection = createProjection(config.srcDim, config.dim, config.seed);
    projectionCache.set(key, projection);
  }
  return projection;
}

async function handleVectorEmbedResult(
  url: URL,
  event: CrowdWebhookEvent,
  db: D1Database,
  env: CrowdEnv,
): Promise<void> {
  const postId = url.searchParams.get('postId');
  const output = extractCallbackOutput(event) as Record<string, unknown> | undefined;
  if (!postId || !output) return;

  const vector = output.vector as number[] | undefined;
  if (!vector || !Array.isArray(vector)) return;

  const model = (output.model as string) || 'Qwen/Qwen3-Embedding-0.6B';
  const dimensions = (output.dimensions as number) || 1024;

  if (env.VECTORIZE) {
    try {
      await env.VECTORIZE.upsert([{ id: postId, values: vector }]);
    } catch (ve) {
      console.error('Vectorize upsert failed:', ve);
    }
  }

  const banditConfig = await loadBanditConfig(env);
  const projected = project(vector, getProjection(banditConfig));
  await db
    .prepare(
      'INSERT OR REPLACE INTO post_embeddings (post_id, embedding, model, dimensions, bandit_vec, bandit_cfg) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(postId, JSON.stringify(vector), model, dimensions, JSON.stringify(projected), projConfigKey(banditConfig))
    .run();
  console.log(`Vector embed webhook done for post ${postId}: dims=${dimensions}`);
}

/**
 * Handle an orchestrator callback. Returns the HTTP response for the route:
 * `400` for malformed payloads, `200 { received: true }` otherwise (including
 * failures, so the orchestrator does not retry a callback we already observed).
 */
export async function handleCrowdWebhook(request: Request, env: CrowdEnv, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const callbackType = callbackTypeFromUrl(url);

  try {
    const event = parseCrowdWebhook(await request.json());
    if (!event) return new Response('Bad Request', { status: 400 });

    if (event.status === 'done') {
      if (callbackType === 'nsfw') {
        await handleNsfwResult(url, event, db);
      } else if (callbackType === 'vector-embed') {
        await handleVectorEmbedResult(url, event, db, env);
      }
    } else if (event.status === 'failed') {
      console.log(
        `Task failed: taskId=${event.taskId}, type=${callbackType || 'unknown'}, error=${event.error || 'unknown'}`,
      );
      if (callbackType === 'nsfw') {
        const postId = url.searchParams.get('postId');
        if (postId) {
          await db
            .prepare('UPDATE post_nsfw_scans SET status = ?, scanned_at = ? WHERE post_id = ?')
            .bind('failed', new Date().toISOString(), postId)
            .run();
        }
      }
    }

    return json({ received: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return json({ received: true });
  }
}

/** Apply NSFW content tags to a post's hashtags. Returns true when changed. */
export async function applyNsfwTags(db: D1Database, postId: string, tags: string[]): Promise<boolean> {
  if (tags.length === 0) return false;

  const postRow = (await db.prepare('SELECT hashtags FROM posts WHERE id = ?').bind(postId).first()) as {
    hashtags: string;
  } | null;
  if (!postRow) return false;

  const hashtags: string[] = JSON.parse(postRow.hashtags || '[]');
  const normalized = new Set(hashtags.map((t) => t.toLowerCase()));
  let changed = false;

  for (const tag of tags) {
    if (!normalized.has(tag.toLowerCase())) {
      hashtags.push(tag);
      normalized.add(tag.toLowerCase());
      changed = true;
    }
  }

  if (!changed) return false;

  const result = await db
    .prepare('UPDATE posts SET hashtags = ? WHERE id = ?')
    .bind(JSON.stringify(hashtags), postId)
    .run();
  return result.success;
}
