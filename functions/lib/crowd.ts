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
  type CrowdWebhookReplayGuard,
  callbackTypeFromUrl,
  DEFAULT_WORKLOAD_TIMEOUT_MS,
  extractCallbackOutput,
  FlaxiaClient,
  type NudeNetDetection,
  parseCrowdWebhook,
  readCrowdWebhookHeaders,
  resolveNsfwTags,
  verifyCrowdWebhook,
} from '@flaxia/sdk';
import { stripPostColors } from '../../src/lib/post-colors.ts';
import { postTextSha } from './ai-index.ts';
import { loadBlocklist, matchBlocklist, matchSignatureEntry } from './scan/blocklist.ts';
import { clamavVerdict, parseContainerOutput, parseVideoPhashes } from './scan/container-result.ts';
import { getFileScan, recordInfection, setScanPhash, setScanStatus } from './scan/db.ts';
import type { FileFeatures } from './scan/features.ts';

export interface CrowdEnv {
  CROWD_ORCHESTRATOR_URL?: string;
  CROWD_API_KEY?: string;
  /** Secret for signed scan-file tickets; falls back to the API key. */
  CROWD_WEBHOOK_SECRET?: string;
  /**
   * Crowd's `WEBHOOK_SIGNING_SECRET`. Every webhook delivery is verified with
   * the SDK's shared `X-Flaxia-Signature/Timestamp/Nonce` contract; without it
   * the route fails closed outside a local dev/test server.
   */
  CROWD_WEBHOOK_SIGNING_SECRET?: string;
  /**
   * Ops kill-switch: when '1', screening/embedding submissions are skipped
   * (embeds queue for later) so a Crowd outage can be shed without a deploy.
   */
  CROWD_SCREENING_DISABLED?: string;
  FILE_SCAN_CLAMAV_IMAGE?: string;
  FILE_SCAN_VIDEO_PHASH_IMAGE?: string;
  /** Orchestrator task-body cap in bytes; defaults to 1 MiB. */
  CROWD_MAX_PAYLOAD_BYTES?: string;
  /** Enable R2-backed file references for scans after Crowd and nodes are deployed. */
  CROWD_SCAN_FILE_SOURCES?: string;
  BASE_URL?: string;
  CACHE?: KVNamespace;
  VECTORIZE?: VectorizeLike;
  /** R2 bucket holding uploads; binds a verdict to the bytes it screened. */
  BUCKET?: R2Bucket;
}

/** Minimal Vectorize surface used by the vector-embed callback. */
export interface VectorizeLike {
  upsert(vectors: Array<{ id: string; values: number[] }>): Promise<unknown>;
}

export interface CrowdConfig {
  orchestratorUrl: string;
  apiKey: string;
  baseUrl: string;
  /** Secret for signed scan-file tickets; empty when Crowd is unconfigured. */
  fileScanTicketSecret: string;
  /** Crowd `WEBHOOK_SIGNING_SECRET` for `X-Flaxia-*` header signatures. */
  webhookSigningSecret: string;
  configured: boolean;
  /**
   * True only for local/test deployments. An unconfigured *production*
   * deployment must reject unsigned callbacks instead of accepting anything.
   */
  allowUnsignedCallbacks: boolean;
  /** Ops kill-switch (CROWD_SCREENING_DISABLED=1): shed Crowd load on outage. */
  screeningDisabled: boolean;
}

export const IMAGE_KEY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/** True when an R2 key points at an image (the only thing NudeNet can screen). */
export function isImageKey(key: string | null | undefined): key is string {
  if (!key) return false;
  const lower = key.toLowerCase();
  return IMAGE_KEY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const NSFW_RATE_LIMIT_MS = 10_000;
const EMBED_RATE_LIMIT_MS = 10_000;
const TAG_RATE_LIMIT_MS = 10_000;
const PENDING_EMBED_MAX_ATTEMPTS = 5;

/** Taxonomy size for AI trend tagging (candidates + "none" choice). */
export const TREND_TAG_CANDIDATE_LIMIT = 20;
/** Decision model id (must match the Crowd node allowlist). */
export const DECISION_MODEL_ID = 'LiquidAI/d1-omni-600M';
/** EmbeddingGemma 2 native dimensions. */
export const EMBEDDING_DIMENSIONS = 768;
/** Max image URLs per embed/decision call (vision token budget guard). */
export const MAX_MEDIA_URLS = 8;

// One row per (post, media object): a post with 4 image attachments needs 4
// verdicts, and a post_id-only key could only ever hold one.
// `content_sha` records the bytes a verdict belongs to: media keys are stable
// across overwrites (gif/{postId}/{position}.{ext}), so a verdict keyed only on
// (post, key) would keep vouching for an image that was swapped in later.
const NSFW_SCAN_SCHEMA = `post_id TEXT NOT NULL, media_key TEXT NOT NULL DEFAULT '', task_id TEXT, content_sha TEXT, ai_passed INTEGER, status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'done', 'failed')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), scanned_at TEXT, PRIMARY KEY (post_id, media_key)`;
const PENDING_EMBEDS_SCHEMA = `post_id TEXT PRIMARY KEY, text TEXT NOT NULL, payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_error TEXT`;
// Replay guard for the header-signed Crowd webhook. A nonce is inserted once
// and retained until the timestamp tolerance window closes, so a captured
// (body, signature) pair can never be replayed.
const CROWD_WEBHOOK_NONCE_SCHEMA = `nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL`;

// In-flight / rate-limit guards. Kept module-scoped so every route bundled into
// the same Pages Function worker shares one budget.
const nsfwScanPosts = new Set<string>();
const embeddingPosts = new Set<string>();
const taggingPosts = new Set<string>();
let lastNsfwSubmitTime = 0;
let lastEmbedTime = 0;
let lastTagTime = 0;

/** Resolve Crowd configuration from the Pages/Worker environment. */
export function crowdConfig(env: CrowdEnv): CrowdConfig {
  const orchestratorUrl = (env.CROWD_ORCHESTRATOR_URL || '').replace(/\/+$/, '');
  const apiKey = env.CROWD_API_KEY || '';
  const baseUrl = (env.BASE_URL || 'https://flaxia.app').replace(/\/+$/, '');
  const configured = Boolean(orchestratorUrl && apiKey);
  // Reusing the API key keeps scan-file tickets working in exactly the
  // deployments that can submit tasks; set CROWD_WEBHOOK_SECRET to rotate that
  // ticket key independently of the API key.
  const fileScanTicketSecret = configured ? env.CROWD_WEBHOOK_SECRET || apiKey : '';
  // Webhook authentication uses Crowd's dedicated WEBHOOK_SIGNING_SECRET. The
  // legacy `?sig=` query contract is retired and is never consulted.
  const webhookSigningSecret = env.CROWD_WEBHOOK_SIGNING_SECRET || '';
  // Without a signing secret, unsigned callbacks are only tolerated when the
  // instance is a local dev/test server. Production fails closed.
  const allowUnsignedCallbacks = !configured && /^http:\/\/localhost(:\d+)?$/.test(baseUrl);
  return {
    orchestratorUrl,
    apiKey,
    baseUrl,
    fileScanTicketSecret,
    webhookSigningSecret,
    configured,
    allowUnsignedCallbacks,
    screeningDisabled: env.CROWD_SCREENING_DISABLED === '1',
  };
}

/** Build a client, or null when Crowd is unconfigured (calls become no-ops). */
export function getCrowdClient(config: CrowdConfig): FlaxiaClient | null {
  if (!config.configured) return null;
  return new FlaxiaClient({ baseUrl: `${config.orchestratorUrl}/crowd`, apiKey: config.apiKey });
}

// ── File-scan tickets ──
//
// `/api/crowd/webhook` is a standalone Pages Function: it never passes through
// the Hono middleware in functions/api/[[route]].ts, so nothing authenticates
// the caller. Every delivery is verified with Crowd's `X-Flaxia-*` HMAC headers
// (see handleCrowdWebhook); the retired `?sig=` query contract is no longer
// accepted. The HMAC helpers below are now used only for scan-file tickets.

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent byte compare so a wrong signature cannot be brute-forced by timing. */
function signatureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Short-lived R2 scan-file tickets ──
// The ticket is carried in an Authorization header (never a query string) and
// binds a node's one-file GET to the exact R2 key, bytes, and size Flaxia queued.
export const FILE_SCAN_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const FILE_SCAN_TICKET_TTL_MS = 30 * 60 * 1000;

export interface FileScanTicketClaims {
  version: 1;
  key: string;
  sha256: string;
  size: number;
  expiresAt: number;
}

function base64UrlEncodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeText(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validScanFileKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return !key.split('/').some((part) => part === '.' || part === '..');
}

/** Mint a narrowly scoped, 30-minute bearer for one scanned object. */
export async function createFileScanTicket(
  config: CrowdConfig,
  input: { key: string; sha256: string; size: number },
): Promise<string> {
  if (!config.fileScanTicketSecret) throw new Error('Crowd file-scan signing secret is not configured');
  if (!validScanFileKey(input.key)) throw new Error('Invalid R2 key for file-scan ticket');
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error('Invalid SHA-256 for file-scan ticket');
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > FILE_SCAN_SOURCE_MAX_BYTES) {
    throw new Error('File exceeds the Crowd scan-file limit');
  }

  const claims: FileScanTicketClaims = {
    version: 1,
    key: input.key,
    sha256: input.sha256.toLowerCase(),
    size: input.size,
    expiresAt: Date.now() + FILE_SCAN_TICKET_TTL_MS,
  };
  const body = base64UrlEncodeText(JSON.stringify(claims));
  const signature = await hmacHex(config.fileScanTicketSecret, `flaxia-file-scan-v1.${body}`);
  return `${body}.${signature}`;
}

/** Verify signature, scope, size, and expiry before touching R2 or D1. */
export async function verifyFileScanTicket(
  env: CrowdEnv,
  ticket: string,
  now = Date.now(),
): Promise<FileScanTicketClaims | null> {
  const secret = crowdConfig(env).fileScanTicketSecret;
  if (!secret || typeof ticket !== 'string' || ticket.length > 4096) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1]!)) return null;
  const [body, signature] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  const expected = await hmacHex(secret, `flaxia-file-scan-v1.${body}`);
  if (!signatureEquals(signature, expected)) return null;

  const decoded = base64UrlDecodeText(body);
  if (!decoded) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  const value = claims as Partial<FileScanTicketClaims>;
  if (
    value.version !== 1 ||
    !validScanFileKey(value.key) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    (value.size as number) > FILE_SCAN_SOURCE_MAX_BYTES ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= now ||
    (value.expiresAt as number) > now + FILE_SCAN_TICKET_TTL_MS + 60_000
  ) {
    return null;
  }
  return value as FileScanTicketClaims;
}

// ── Schema bootstrap ──

// Databases created before `content_sha` existed need the column added once per
// isolate; SQLite has no `ADD COLUMN IF NOT EXISTS`.
const nsfwShaColumnChecked = new WeakSet<D1Database>();

async function ensureNsfwContentShaColumn(db: D1Database): Promise<void> {
  if (nsfwShaColumnChecked.has(db)) return;
  try {
    await db.prepare('ALTER TABLE post_nsfw_scans ADD COLUMN content_sha TEXT').run();
  } catch {
    // Already present (fresh CREATE above, or a previous ALTER).
  }
  try {
    await db.prepare('ALTER TABLE post_nsfw_scans ADD COLUMN ai_passed INTEGER').run();
  } catch {
    // Already present, or deployed before migration 0110.
  }
  nsfwShaColumnChecked.add(db);
}

export async function ensureNsfwScansTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS post_nsfw_scans (${NSFW_SCAN_SCHEMA})`).run();
    await ensureNsfwContentShaColumn(db);
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_nsfw_scans_status ON post_nsfw_scans(status, created_at)').run();
  } catch (e) {
    console.error('Failed to ensure post_nsfw_scans table:', e);
  }
}

const embeddingSourceChecked = new WeakSet<D1Database>();
async function ensureEmbeddingSourceColumn(db: D1Database): Promise<void> {
  if (embeddingSourceChecked.has(db)) return;
  try {
    await db.prepare('ALTER TABLE post_embeddings ADD COLUMN source_sha TEXT').run();
  } catch {
    // The migration or another isolate may already have added it.
  }
  embeddingSourceChecked.add(db);
}

export async function ensurePendingEmbedsTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS pending_embeddings (${PENDING_EMBEDS_SCHEMA})`).run();
    try {
      await db.prepare('ALTER TABLE pending_embeddings ADD COLUMN payload TEXT').run();
    } catch {
      // Already present.
    }
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_pending_embeddings_created ON pending_embeddings(created_at)')
      .run();
  } catch (e) {
    console.error('Failed to ensure pending_embeddings table:', e);
  }
}

const crowdNonceTableChecked = new WeakSet<D1Database>();
async function ensureCrowdWebhookNoncesTable(db: D1Database): Promise<void> {
  if (crowdNonceTableChecked.has(db)) return;
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS crowd_webhook_nonces (${CROWD_WEBHOOK_NONCE_SCHEMA})`).run();
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_crowd_webhook_nonces_expiry ON crowd_webhook_nonces(expires_at)')
      .run();
    crowdNonceTableChecked.add(db);
  } catch (e) {
    // Leave the table unchecked so the next callback retries; the guard below
    // fails closed until the table exists.
    console.error('Failed to ensure crowd_webhook_nonces table:', e);
  }
}

/**
 * D1-backed replay guard shared by every isolate. A nonce is accepted exactly
 * once; a storage failure rejects the callback rather than risking a replay.
 */
function createCrowdWebhookReplayGuard(db: D1Database): CrowdWebhookReplayGuard {
  return {
    async check(nonce: string, expiresAtMs: number): Promise<boolean> {
      try {
        await ensureCrowdWebhookNoncesTable(db);
        // Opportunistic cleanup keeps the table bounded without a cron.
        await db.prepare('DELETE FROM crowd_webhook_nonces WHERE expires_at < ?').bind(Date.now()).run();
        const result = await db
          .prepare('INSERT OR IGNORE INTO crowd_webhook_nonces (nonce, expires_at) VALUES (?, ?)')
          .bind(nonce, expiresAtMs)
          .run();
        return (result.meta?.changes ?? 0) > 0;
      } catch (e) {
        console.error('Crowd webhook nonce check failed:', e);
        return false;
      }
    },
  };
}

// ── NSFW screening (NudeNet) ──

/**
 * SHA-256 of the stored object, used to decide whether an existing verdict
 * still describes the bytes at `mediaKey`. Returns null when the bucket is
 * unavailable or the object is gone, in which case callers keep the previous
 * "already scanned" behaviour instead of re-submitting blindly.
 */
async function mediaContentSha(env: CrowdEnv, mediaKey: string): Promise<string | null> {
  const bucket = env.BUCKET;
  if (!bucket) return null;
  try {
    const object = await bucket.get(mediaKey);
    if (!object) return null;
    const digest = await crypto.subtle.digest('SHA-256', await object.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    console.error(`Failed to hash ${mediaKey} for NSFW screening:`, e);
    return null;
  }
}

async function markNsfwScan(
  db: D1Database,
  postId: string,
  mediaKey: string,
  status: string,
  opts: { taskId?: string; contentSha?: string | null } = {},
): Promise<void> {
  try {
    if (status === 'submitted') {
      // A re-submission rebinds the row to the new task and content, so a late
      // verdict for the previous task is rejected by handleNsfwResult.
      await db
        .prepare(
          `INSERT INTO post_nsfw_scans (post_id, media_key, status, task_id, content_sha)
           VALUES (?, ?, 'submitted', ?, ?)
           ON CONFLICT(post_id, media_key) DO UPDATE SET
             status = 'submitted',
             task_id = excluded.task_id,
             content_sha = excluded.content_sha,
             ai_passed = NULL,
             scanned_at = NULL`,
        )
        .bind(postId, mediaKey, opts.taskId ?? null, opts.contentSha ?? null)
        .run();
    } else {
      await db
        .prepare('UPDATE post_nsfw_scans SET status = ?, scanned_at = ? WHERE post_id = ? AND media_key = ?')
        .bind(status, new Date().toISOString(), postId, mediaKey)
        .run();
    }
  } catch (e) {
    console.error(`Failed to record NSFW scan state for post ${postId} [${mediaKey}]:`, e);
  }
}

export interface SubmitNsfwOptions {
  /** Set false to skip the global 10s ceiling (admin backfill only). */
  respectThrottle?: boolean;
  /** Admin backfill can obtain a recorded verdict for historical done rows. */
  recheckCompleted?: boolean;
}

/**
 * Submit one image for NudeNet screening. Best-effort: skips when Crowd is
 * unconfigured, when the key is not an image, when this object already has a
 * verdict, or when rate-limited. Returns true only when a task was actually
 * handed to the orchestrator.
 */
export async function submitDetectNsfw(
  db: D1Database,
  env: CrowdEnv,
  postId: string,
  mediaKey: string | null,
  opts: SubmitNsfwOptions = {},
): Promise<boolean> {
  const config = crowdConfig(env);
  if (!config.configured || !mediaKey || !isImageKey(mediaKey)) return false;
  // Ops kill-switch: shed screening load during a Crowd outage.
  if (config.screeningDisabled) return false;

  const dedupeKey = postId + ' ' + mediaKey;
  if (nsfwScanPosts.has(dedupeKey)) return false;
  nsfwScanPosts.add(dedupeKey);

  try {
    await ensureNsfwScansTable(db);

    // A verdict only stands for the bytes it screened. Media keys are reused
    // across overwrites, so "row is done" is not enough: compare the stored
    // hash with the live object and re-screen whenever it moved.
    const contentSha = await mediaContentSha(env, mediaKey);

    // Checked before the throttle: an already-screened image must not consume
    // the shared budget when a caller walks a post's image list.
    const existing = (await db
      .prepare('SELECT status, content_sha FROM post_nsfw_scans WHERE post_id = ? AND media_key = ?')
      .bind(postId, mediaKey)
      .first()) as { status: string; content_sha: string | null } | null;
    if (existing?.status === 'done' && !opts.recheckCompleted) {
      // No hash available (no bucket binding, or the object vanished): keep the
      // old behaviour rather than re-submitting on every call.
      if (!contentSha || existing.content_sha === contentSha) return false;
      console.log(`NSFW verdict for post ${postId} [${mediaKey}] no longer matches the stored image; re-screening`);
    }

    if (opts.respectThrottle !== false && Date.now() - lastNsfwSubmitTime < NSFW_RATE_LIMIT_MS) return false;

    const client = getCrowdClient(config);
    if (!client) return false;

    lastNsfwSubmitTime = Date.now();
    // `key` says which object of the post this verdict belongs to.
    // buildCallbackUrl omits empty params, so legacy callbacks stay postId-only.
    const callbackUrl = buildCallbackUrl({
      baseUrl: config.baseUrl,
      type: 'nsfw',
      params: { postId, key: mediaKey },
    });
    const res = await client.submit({
      workload: 'nudenet',
      payload: { imageUrl: `${config.baseUrl}/api/images/${mediaKey}` },
      callbackUrl,
      timeoutMs: DEFAULT_WORKLOAD_TIMEOUT_MS.nudenet,
    });
    await markNsfwScan(db, postId, mediaKey, 'submitted', { taskId: res.taskId, contentSha });
    console.log(`NSFW detection task submitted for post ${postId} [${mediaKey}] (task ${res.taskId})`);
    return true;
  } catch (err) {
    console.error(`NSFW detection submission failed for post ${postId} (${mediaKey}):`, err);
    return false;
  } finally {
    nsfwScanPosts.delete(dedupeKey);
  }
}

/**
 * Reconcile a post's scan rows with the images it currently carries, then try
 * each one. The global throttle lets a single new image through per call, so
 * the rest are picked up by a later write or by the admin backfill.
 */
export async function screenPostImages(
  db: D1Database,
  env: CrowdEnv,
  postId: string,
  imageKeys: string[],
): Promise<void> {
  try {
    await ensureNsfwScansTable(db);

    const wanted = [...new Set(imageKeys.filter(isImageKey))];
    const storedResult = await db
      .prepare('SELECT media_key FROM post_nsfw_scans WHERE post_id = ?')
      .bind(postId)
      .all<{ media_key: string }>();
    const stored = storedResult.results || [];
    const wantedSet = new Set(wanted);
    const stale = stored.map((r) => r.media_key).filter((k) => !wantedSet.has(k));
    if (stale.length > 0) {
      const placeholders = stale.map(() => '?').join(',');
      await db
        .prepare(`DELETE FROM post_nsfw_scans WHERE post_id = ? AND media_key IN (${placeholders})`)
        .bind(postId, ...stale)
        .run();
    }

    for (const key of wanted) {
      await submitDetectNsfw(db, env, postId, key);
    }
  } catch (e) {
    console.error(`Failed to screen images for post ${postId}:`, e);
  }
}

// ── Vector embeddings ──

export interface PostMediaInput {
  /** R2 keys of image attachments (incl. gif/thumbnail single image). */
  imageKeys?: string[];
  /** R2 key of the audio attachment (16kHz mono is transcoded node-side). */
  audioKey?: string;
  /** R2 key of the video attachment (first frame is sampled node-side). */
  videoKey?: string;
}

export interface PostMediaUrls {
  imageUrls: string[];
  audioUrl?: string;
  videoUrl?: string;
}

/** Node-fetchable public URLs for a post's media (same contract as NSFW). */
export function postMediaUrls(config: CrowdConfig, media: PostMediaInput): PostMediaUrls {
  const imageUrls = (media.imageKeys ?? [])
    .filter((key): key is string => Boolean(key) && isImageKey(key))
    .slice(0, MAX_MEDIA_URLS)
    .map((key) => `${config.baseUrl}/api/images/${key}`);
  const out: PostMediaUrls = { imageUrls };
  if (media.audioKey) out.audioUrl = `${config.baseUrl}/api/images/${media.audioKey}`;
  if (media.videoKey) out.videoUrl = `${config.baseUrl}/api/images/${media.videoKey}`;
  return out;
}

export async function enqueuePendingEmbed(
  db: D1Database | undefined,
  postId: string,
  text: string,
  attempts = 0,
  error?: string,
  payload?: string,
): Promise<void> {
  if (!db) return;
  try {
    await ensurePendingEmbedsTable(db);
    await db
      .prepare(
        `INSERT INTO pending_embeddings (post_id, text, payload, attempts, last_error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(post_id) DO UPDATE SET
           payload = excluded.payload,
           attempts = excluded.attempts,
           last_error = excluded.last_error`,
      )
      .bind(postId, text, payload ?? null, attempts, error ?? null)
      .run();
  } catch (e) {
    console.error(`Failed to enqueue pending embed for post ${postId}:`, e);
  }
}

async function submitEmbedTask(
  config: CrowdConfig,
  postId: string,
  text: string,
  media?: PostMediaInput,
): Promise<boolean> {
  const client = getCrowdClient(config);
  if (!client) return false;

  // Embed the human-readable body, not the color markup.
  const embeddingText = stripPostColors(text);
  const urls = media ? postMediaUrls(config, media) : { imageUrls: [] as string[] };
  const callbackUrl = buildCallbackUrl({
    baseUrl: config.baseUrl,
    type: 'vector-embed',
    params: { postId, sha: await postTextSha(embeddingText) },
  });
  try {
    await client.submit({
      workload: 'vector-embed',
      payload: {
        text: embeddingText,
        ...(urls.imageUrls.length ? { imageUrls: urls.imageUrls } : {}),
        ...(urls.audioUrl ? { audioUrl: urls.audioUrl } : {}),
        ...(urls.videoUrl ? { videoUrl: urls.videoUrl } : {}),
      } as never,
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
      `SELECT post_id, text, payload, attempts FROM pending_embeddings
       WHERE attempts < ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(PENDING_EMBED_MAX_ATTEMPTS, maxBatch)
    .all<{ post_id: string; text: string; payload: string | null; attempts: number }>();

  let submitted = 0;
  for (const row of rows.results || []) {
    if (embeddingPosts.has(row.post_id)) continue;
    if (respectThrottle && Date.now() - lastEmbedTime < EMBED_RATE_LIMIT_MS) break;

    let media: PostMediaInput | undefined;
    if (row.payload) {
      try {
        media = JSON.parse(row.payload) as PostMediaInput;
      } catch {
        media = undefined;
      }
    }
    const ok = await submitEmbedTask(config, row.post_id, row.text, media);
    if (ok) {
      await db.prepare('DELETE FROM pending_embeddings WHERE post_id = ?').bind(row.post_id).run();
      submitted++;
    } else {
      await enqueuePendingEmbed(
        db,
        row.post_id,
        row.text,
        row.attempts + 1,
        'submission failed',
        row.payload ?? undefined,
      );
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
  media?: PostMediaInput,
): Promise<void> {
  if (embeddingPosts.has(postId)) return;
  embeddingPosts.add(postId);
  try {
    const config = crowdConfig(env);
    if (!db) {
      if (config.configured && !config.screeningDisabled) await submitEmbedTask(config, postId, text, media);
      return;
    }

    // Persist to the outbox before the network call. The submit happens after
    // the response (waitUntil); if the isolate is evicted mid-flight, the row
    // is still queued for the next drain instead of being lost. Both the outbox
    // and `submitEmbedTask` keep the raw body so stripping happens exactly once
    // (it is not idempotent for escaped markers such as `\{red}`).
    const payload = media ? JSON.stringify(media) : undefined;
    await enqueuePendingEmbed(db, postId, text, 0, undefined, payload);
    if (!config.configured || config.screeningDisabled) return;

    // This drain skips `postId` (the in-flight guard), so backfilled rows are
    // submitted here and the current post is handled below without the throttle
    // consuming the same slot twice.
    await drainPendingEmbeds(db, env).catch((e) => console.error('Pending embed drain failed:', e));

    if (Date.now() - lastEmbedTime < EMBED_RATE_LIMIT_MS) return;
    const ok = await submitEmbedTask(config, postId, text, media);
    if (ok) {
      await db.prepare('DELETE FROM pending_embeddings WHERE post_id = ?').bind(postId).run();
    } else {
      await enqueuePendingEmbed(db, postId, text, 1, 'submission failed', payload);
    }
  } finally {
    embeddingPosts.delete(postId);
  }
}

// ── AI trend tagging (d1-omni decision) ──

/**
 * Rank a full choice distribution (incl. "none") and pick the tags to apply.
 *
 * Rule (Top3 + none): sort options by probability desc, take the Top3 slots.
 * "none" is never emitted as a tag; only tags ranked strictly above "none"
 * are added. So: none in Top3 as 1st => 0 tags, 2nd => 1 tag, 3rd => 2 tags;
 * none outside Top3 => 3 tags.
 */
export function pickTopTagsWithNone(probabilities: Record<string, number>, topK = 3): string[] {
  const ranked = Object.entries(probabilities)
    .filter(([, p]) => typeof p === 'number' && Number.isFinite(p))
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
  const top = ranked.slice(0, topK);
  const noneIdx = top.indexOf('none');
  const tagsOnly = noneIdx === -1 ? top : top.slice(0, noneIdx);
  return tagsOnly.filter((t) => t !== 'none');
}

export async function ensureTrendTagTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS trend_tag_candidates (
           tag TEXT PRIMARY KEY,
           score REAL NOT NULL DEFAULT 0,
           is_active INTEGER NOT NULL DEFAULT 1,
           updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         )`,
      )
      .run();
    await db
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_trend_tag_candidates_active ON trend_tag_candidates(is_active, score DESC)',
      )
      .run();
  } catch (e) {
    console.error('Failed to ensure trend_tag_candidates table:', e);
  }
}

/**
 * Rebuild the taxonomy from user-supplied hashtags. Frequency is decayed by
 * recency (7-day window); system tags are excluded so the decision model
 * never has to choose them.
 */
export async function refreshTrendTagCandidates(db: D1Database, limit = TREND_TAG_CANDIDATE_LIMIT): Promise<string[]> {
  await ensureTrendTagTable(db);
  const result = await db
    .prepare(
      `WITH recent AS (
         SELECT hashtags, created_at FROM posts
         WHERE hidden = 0 AND status = 'published' AND parent_id IS NULL
           AND created_at >= datetime('now', '-7 days')
       )
       SELECT
         value AS tag,
         SUM(
           CASE
             WHEN recent.created_at >= datetime('now', '-1 day') THEN 3.0
             WHEN recent.created_at >= datetime('now', '-3 days') THEN 2.0
             ELSE 1.0
           END
         ) AS score
       FROM recent, json_each(recent.hashtags)
       WHERE LOWER(value) NOT IN ('nsfw', 'r18', 'hidden')
       GROUP BY LOWER(value)
       HAVING score >= 3
       ORDER BY score DESC, tag ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ tag: string; score: number }>();

  const tags = (result.results || []).map((r) => String(r.tag));
  const now = new Date().toISOString();
  if (tags.length > 0) {
    const stmts = tags.map((tag, i) =>
      db
        .prepare(
          `INSERT INTO trend_tag_candidates (tag, score, is_active, updated_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(tag) DO UPDATE SET score = excluded.score, is_active = 1, updated_at = excluded.updated_at`,
        )
        .bind(tag, result.results?.[i]?.score ?? 0, now),
    );
    await db.batch(stmts);
  }
  // Retire candidates that fell out of the window.
  if (tags.length > 0) {
    const placeholders = tags.map(() => '?').join(',');
    await db
      .prepare(`UPDATE trend_tag_candidates SET is_active = 0, updated_at = ? WHERE tag NOT IN (${placeholders})`)
      .bind(now, ...tags)
      .run();
  }
  return tags;
}

export async function loadTrendTagCandidates(db: D1Database, limit = TREND_TAG_CANDIDATE_LIMIT): Promise<string[]> {
  await ensureTrendTagTable(db);
  const result = await db
    .prepare('SELECT tag FROM trend_tag_candidates WHERE is_active = 1 ORDER BY score DESC, tag ASC LIMIT ?')
    .bind(limit)
    .all<{ tag: string }>();
  return (result.results || []).map((r) => String(r.tag));
}

/**
 * Submit a post for AI tagging. The decision call carries text + images OR
 * text + audio (never both); posts with both get two calls whose Top3
 * results are merged host-side (dedupe, first-seen wins).
 */
export async function tagPost(
  db: D1Database | undefined,
  env: CrowdEnv,
  postId: string,
  text: string,
  media?: PostMediaInput,
): Promise<void> {
  if (taggingPosts.has(postId)) return;
  taggingPosts.add(postId);
  try {
    const config = crowdConfig(env);
    if (!config.configured || config.screeningDisabled) return;
    if (Date.now() - lastTagTime < TAG_RATE_LIMIT_MS) return;
    const client = getCrowdClient(config);
    if (!client || !db) return;

    let candidates = await loadTrendTagCandidates(db);
    if (candidates.length < 2) {
      candidates = await refreshTrendTagCandidates(db);
    }
    if (candidates.length < 2) return;

    const criteria: Record<string, string> = {};
    for (const tag of candidates) criteria[tag] = tag;
    criteria.none = 'none';
    const questions = {
      trend: {
        type: 'choice',
        instructions: 'この投稿の話題として当てはまるタグを選んでください（該当なしなら none）。',
        criteria,
      },
    };
    const urls = media ? postMediaUrls(config, media) : { imageUrls: [] as string[] };
    const state = stripPostColors(text) || null;

    const calls: Array<{
      imageUrls?: string[];
      audioUrl?: string;
    }> = [];
    if (urls.imageUrls.length > 0) calls.push({ imageUrls: urls.imageUrls });
    if (urls.audioUrl) calls.push({ audioUrl: urls.audioUrl });
    if (calls.length === 0) calls.push({});

    for (const call of calls) {
      const callbackUrl = buildCallbackUrl({
        baseUrl: config.baseUrl,
        type: 'ai-inference',
        params: { postId, kind: 'tag' },
      });
      await client.submit({
        workload: 'ai-inference',
        payload: {
          task: 'decision',
          model: DECISION_MODEL_ID,
          decision: {
            state,
            questions,
            ...(call.imageUrls ? { imageUrls: call.imageUrls } : {}),
            ...(call.audioUrl ? { audioUrl: call.audioUrl } : {}),
          },
        } as never,
        callbackUrl,
        timeoutMs: DEFAULT_WORKLOAD_TIMEOUT_MS['ai-inference'],
      });
      lastTagTime = Date.now();
    }
    console.log(`AI tag task submitted for post ${postId} (calls=${calls.length})`);
  } catch (e) {
    console.error(`AI tag submission failed for post ${postId}:`, e);
  } finally {
    taggingPosts.delete(postId);
  }
}

async function ensureAiTagsColumn(db: D1Database): Promise<void> {
  try {
    await db.prepare("ALTER TABLE posts ADD COLUMN ai_tags TEXT NOT NULL DEFAULT '[]'").run();
  } catch {
    // Already present.
  }
}

async function handleAiInferenceResult(url: URL, event: CrowdWebhookEvent, db: D1Database): Promise<void> {
  const postId = url.searchParams.get('postId');
  const kind = url.searchParams.get('kind');
  if (!postId || kind !== 'tag') return;
  const output = extractCallbackOutput(event) as
    | { answers?: Record<string, { probabilities?: Record<string, number> }> }
    | undefined;
  const probabilities = output?.answers?.trend?.probabilities;
  if (!probabilities) return;
  const picked = pickTopTagsWithNone(probabilities);
  if (picked.length === 0) return;
  await ensureAiTagsColumn(db);
  const row = (await db.prepare('SELECT ai_tags FROM posts WHERE id = ?').bind(postId).first()) as {
    ai_tags: string | null;
  } | null;
  if (!row) return;
  let current: string[] = [];
  try {
    current = row.ai_tags ? (JSON.parse(row.ai_tags) as string[]) : [];
    if (!Array.isArray(current)) current = [];
  } catch {
    current = [];
  }
  const merged = [...current];
  const seen = new Set(merged.map((t) => t.toLowerCase()));
  for (const tag of picked) {
    if (!seen.has(tag.toLowerCase())) {
      merged.push(tag);
      seen.add(tag.toLowerCase());
    }
  }
  if (merged.length === current.length) return;
  await db.prepare('UPDATE posts SET ai_tags = ? WHERE id = ?').bind(JSON.stringify(merged), postId).run();
  console.log(`AI tag webhook for post ${postId}: tags=${picked.join(',')}`);
}

// ── Webhook handling ──

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Crowd's own result ceiling is 4 MiB; allow headroom but never buffer more. */
const MAX_CROWD_WEBHOOK_CHARS = 8 * 1024 * 1024;

/** Read the raw body once, rejecting an oversized payload before buffering it. */
async function readCrowdWebhookBody(request: Request): Promise<string | null> {
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_CROWD_WEBHOOK_CHARS) return null;
  const text = await request.text();
  return text.length > MAX_CROWD_WEBHOOK_CHARS ? null : text;
}

async function handleNsfwResult(url: URL, event: CrowdWebhookEvent, db: D1Database): Promise<void> {
  const postId = url.searchParams.get('postId');
  // Older callbacks carry no key: they screened the post's single legacy image.
  const mediaKey = url.searchParams.get('key') ?? '';
  if (!postId) return;

  // Only the task we last submitted for this (post, key) may write a verdict.
  // Without this, a slow callback for an image that has since been replaced at
  // the same key would mark the new bytes as screened.
  const row = (await db
    .prepare('SELECT task_id FROM post_nsfw_scans WHERE post_id = ? AND media_key = ?')
    .bind(postId, mediaKey)
    .first()) as { task_id: string | null } | null;
  if (row?.task_id && row.task_id !== event.taskId) {
    console.log(`Ignoring stale NSFW callback for post ${postId} [${mediaKey}]: ${event.taskId} != ${row.task_id}`);
    return;
  }

  // `extractCallbackOutput` unwraps `{result:{output}}` shapes; the SDK allows
  // both, and reading `event.result` directly would silently yield no
  // detections if the orchestrator ever nests the workload output.
  const output = extractCallbackOutput(event) as { detections?: NudeNetDetection[] } | undefined;
  const detections = output?.detections ?? [];

  // Missing/malformed output is not evidence that an image passed review.
  const validDetections =
    Array.isArray(output?.detections) &&
    output.detections.every(
      (d) => d && typeof d.label === 'string' && Number.isFinite(d.score) && d.score >= 0 && d.score <= 1,
    );
  const { nsfw, tags } = resolveNsfwTags(validDetections ? detections : []);
  const aiPassed = validDetections ? (nsfw ? 0 : 1) : null;
  const applied = await applyNsfwTags(db, postId, tags);
  await db
    .prepare(
      `INSERT INTO post_nsfw_scans (post_id, media_key, status, scanned_at, ai_passed) VALUES (?, ?, 'done', ?, ?)
       ON CONFLICT(post_id, media_key) DO UPDATE SET status = 'done', scanned_at = excluded.scanned_at,
         ai_passed = excluded.ai_passed`,
    )
    .bind(postId, mediaKey, new Date().toISOString(), aiPassed)
    .run();
  console.log(
    `NSFW webhook for post ${postId} [${mediaKey}]: nsfw=${nsfw}, tags=${tags.join(',') || 'none'}, applied=${applied}`,
  );
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
  if (
    !Array.isArray(vector) ||
    !vector.length ||
    !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
  )
    return;

  const sourceSha = url.searchParams.get('sha');
  if (sourceSha) {
    const current = await db.prepare('SELECT text FROM posts WHERE id = ?').bind(postId).first<{ text: string }>();
    if (!current || sourceSha !== (await postTextSha(stripPostColors(current.text)))) return;
  }
  await ensureEmbeddingSourceColumn(db);

  const model = (output.model as string) || 'google/embeddinggemma-2';
  const dimensions = (output.dimensions as number) || EMBEDDING_DIMENSIONS;
  // Dimension guard: never compare new-model vectors against old ones.
  // The Vectorize index is being rebuilt for 768d, so skip the upsert until
  // callback vectors match the index dimension and rely on D1.
  if (dimensions !== EMBEDDING_DIMENSIONS) {
    console.warn(`Vector embed webhook for post ${postId}: unexpected dims=${dimensions}, storing in D1 only`);
  }

  if (env.VECTORIZE && dimensions === EMBEDDING_DIMENSIONS) {
    try {
      await env.VECTORIZE.upsert([{ id: postId, values: vector }]);
    } catch (ve) {
      console.error('Vectorize upsert failed:', ve);
    }
  }

  await db
    .prepare(
      'INSERT OR REPLACE INTO post_embeddings (post_id, embedding, model, dimensions, source_sha) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(postId, JSON.stringify(vector), model, dimensions, sourceSha)
    .run();
  console.log(`Vector embed webhook done for post ${postId}: dims=${dimensions}`);
}

/** Full SHA for new callbacks; accept 16-character prefixes during rollout. */
function scanSha(url: URL): string | undefined {
  const sha = url.searchParams.get('sha')?.toLowerCase();
  return sha && (/^[0-9a-f]{64}$/.test(sha) || /^[0-9a-f]{16}$/.test(sha)) ? sha : undefined;
}

/** The orchestrator reported the task itself failed (not a verdict). */
async function handleFileScanTaskFailure(url: URL, event: CrowdWebhookEvent, db: D1Database): Promise<void> {
  const r2Key = url.searchParams.get('key');
  const kind = url.searchParams.get('kind') ?? 'clamav';
  const submittedSha = scanSha(url);
  if (!r2Key || !submittedSha) return;
  if (kind !== 'clamav') return; // keyframe hashing is best-effort
  const detail = (event.error || 'task_failed').slice(0, 300);
  await setScanStatus(db, r2Key, 'failed', { detail, shaPrefix: submittedSha });
}

/**
 * Apply a completed file-scan container task:
 *   kind=clamav      -> clean / infected / failed (+ blocklist + KV on hit)
 *   kind=video-phash -> store keyframe hashes, then re-run the blocklist
 * New callbacks carry the full submitted SHA, so a stale verdict can blocklist
 * the scanned bytes without changing the status of a same-key replacement.
 */
async function handleFileScanResult(url: URL, event: CrowdWebhookEvent, db: D1Database, env: CrowdEnv): Promise<void> {
  const r2Key = url.searchParams.get('key');
  const kind = url.searchParams.get('kind') ?? 'clamav';
  const submittedSha = scanSha(url);
  if (!r2Key || !submittedSha) return;

  const output = parseContainerOutput(extractCallbackOutput(event));
  if (!output) {
    if (kind === 'clamav') {
      await setScanStatus(db, r2Key, 'failed', { detail: 'malformed_result', shaPrefix: submittedSha });
    }
    return;
  }

  if (kind === 'video-phash') {
    const hashes = parseVideoPhashes(output.stdout);
    if (!hashes) return;
    const row = await getFileScan(db, r2Key);
    const submittedSha256 =
      submittedSha.length === 64 ? submittedSha : row?.sha256.startsWith(submittedSha) ? row.sha256 : undefined;
    if (!submittedSha256) return;

    const rowMatchesSubmitted = row?.sha256 === submittedSha256 ? row : null;
    const joined = hashes.join(',');
    await setScanPhash(db, r2Key, joined, submittedSha);
    const features: FileFeatures = {
      // The callback hashes belong to the submitted object, even when the key
      // has since been reused. Never borrow B's metadata while judging A.
      sha256: submittedSha256,
      kind: rowMatchesSubmitted ? (rowMatchesSubmitted.kind as FileFeatures['kind']) : 'video',
      structureHash: rowMatchesSubmitted?.structure_hash ?? undefined,
      textHash: rowMatchesSubmitted?.text_hash ?? undefined,
      phash: joined,
    };
    try {
      const hit = await matchBlocklist(db, features);
      if (hit) {
        await recordInfection(
          db,
          env.CACHE,
          r2Key,
          hit.signature ?? 'blocklist_phash',
          'phash_blocklist',
          submittedSha,
        );
        console.log(`Video phash hit for ${r2Key} (entry #${hit.id})`);
      }
    } catch (e) {
      // Fail open here: an outage must not permanently block a clean file.
      console.error('Post-scan blocklist lookup failed:', e);
    }
    return;
  }

  const verdict = clamavVerdict(output);
  if (verdict.status === 'infected') {
    // A curated `signature` entry matching the verdict name supplies the
    // recorded reason; blocking happens either way.
    let reason = 'clamav';
    try {
      const hit = matchSignatureEntry(verdict.signature, await loadBlocklist(db));
      if (hit?.reason) reason = hit.reason;
    } catch (e) {
      console.error('Signature blocklist lookup failed:', e);
    }
    await recordInfection(db, env.CACHE, r2Key, verdict.signature, reason, submittedSha);
    console.log(`ClamAV infected ${r2Key}: ${verdict.signature}`);
    return;
  }
  if (verdict.status === 'failed') {
    await setScanStatus(db, r2Key, 'failed', { detail: verdict.detail ?? 'scan_error', shaPrefix: submittedSha });
    return;
  }

  // Clean verdict: re-run the blocklist so entries added between upload and
  // completion still take effect, then mark the row clean.
  try {
    const row = await getFileScan(db, r2Key);
    if (row?.sha256.startsWith(submittedSha)) {
      const hit = await matchBlocklist(db, {
        sha256: row.sha256,
        kind: row.kind as FileFeatures['kind'],
        structureHash: row.structure_hash ?? undefined,
        textHash: row.text_hash ?? undefined,
        phash: row.phash ?? undefined,
      });
      if (hit) {
        await recordInfection(db, env.CACHE, r2Key, hit.signature, hit.reason ?? 'blocklist', submittedSha);
        return;
      }
      // No marker is cleared here: another container task for the same bytes
      // (for example the video pHash scan) may mark them infected between this
      // blocklist read and the status update. The serve-time gate clears a
      // stale marker itself once the row is verifiably not infected.
    }
  } catch (e) {
    console.error('Post-scan blocklist lookup failed:', e);
  }
  await setScanStatus(db, r2Key, 'clean', { shaPrefix: submittedSha });
}

/**
 * Handle an orchestrator callback. Every delivery must carry Crowd's
 * `X-Flaxia-Signature/Timestamp/Nonce` headers signed with
 * `WEBHOOK_SIGNING_SECRET`; the retired `?sig=` query contract is ignored.
 * Unsigned callbacks are accepted only by an unconfigured local dev/test
 * server where Crowd cannot submit. Returns `401` for a missing or invalid
 * signature, `413` for an oversized body, `200 { received: true }` for a
 * callback we observed (including a signed body that can never parse, since
 * retrying it would only loop), and `500` when an unexpected error left the
 * row unwritten.
 */
export async function handleCrowdWebhook(request: Request, env: CrowdEnv, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const callbackType = callbackTypeFromUrl(url);
  const config = crowdConfig(env);

  try {
    // The header contract signs the raw body, so it must be read before the
    // signature is checked. Bound it first so an unauthenticated caller cannot
    // make the isolate buffer an arbitrarily large payload.
    const rawBody = await readCrowdWebhookBody(request);
    if (rawBody === null) return new Response('Payload Too Large', { status: 413 });

    const headers = readCrowdWebhookHeaders(request.headers);
    let event: CrowdWebhookEvent | null = null;

    if (config.webhookSigningSecret) {
      // Crowd contract: X-Flaxia-Signature/Timestamp/Nonce over the raw body.
      // The SDK is the shared source of truth with the worker.
      const verified = await verifyCrowdWebhook({
        secret: config.webhookSigningSecret,
        body: rawBody,
        signature: headers.signature,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        replayGuard: createCrowdWebhookReplayGuard(db),
      });
      if (!verified.ok) {
        // A signed body that can never parse should not be retried forever.
        if (verified.reason === 'invalid_body') return json({ received: true });
        console.warn(`Crowd webhook rejected (${verified.reason})`);
        return new Response('Forbidden', { status: 401 });
      }
      event = verified.payload;
    } else if (config.allowUnsignedCallbacks) {
      // Local dev/test only: Crowd is unconfigured, so nothing can sign.
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json({ received: true });
      }
      event = parseCrowdWebhook(body);
      if (!event) return new Response('Bad Request', { status: 400 });
    } else {
      console.warn('Crowd webhook rejected (signing secret is not configured)');
      return new Response('Forbidden', { status: 401 });
    }

    if (event.status === 'done') {
      if (callbackType === 'nsfw') {
        await handleNsfwResult(url, event, db);
      } else if (callbackType === 'vector-embed') {
        await handleVectorEmbedResult(url, event, db, env);
      } else if (callbackType === 'ai-inference') {
        await handleAiInferenceResult(url, event, db);
      } else if (callbackType === 'file-scan') {
        await handleFileScanResult(url, event, db, env);
      }
    } else if (event.status === 'failed') {
      console.log(
        `Task failed: taskId=${event.taskId}, type=${callbackType || 'unknown'}, error=${event.error || 'unknown'}`,
      );
      if (callbackType === 'nsfw') {
        const postId = url.searchParams.get('postId');
        const mediaKey = url.searchParams.get('key') ?? '';
        if (postId) {
          // Same staleness rule as the done path: a failure report for a task we
          // already replaced must not mark the current attempt as failed.
          await db
            .prepare(
              `UPDATE post_nsfw_scans SET status = ?, scanned_at = ?
               WHERE post_id = ? AND media_key = ? AND (task_id IS NULL OR task_id = ?)`,
            )
            .bind('failed', new Date().toISOString(), postId, mediaKey, event.taskId)
            .run();
        }
      } else if (callbackType === 'file-scan') {
        await handleFileScanTaskFailure(url, event, db);
      }
    }

    return json({ received: true });
  } catch (e) {
    // Fail loudly: the row was not written. Crowd does not retry webhook
    // deliveries (Coordinator.deliverCallback is a single fire-and-forget
    // fetch), so the consumed nonce is kept: releasing it would only reopen a
    // replay window without recovering the verdict.
    console.error('Webhook error:', e);
    return json({ received: false, error: 'callback_failed' }, 500);
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
