/**
 * Shared helpers for multi-media post attachments (image / audio / video / document).
 *
 * One post can carry up to MAX_ATTACHMENTS files (50MB total, 25MB each on
 * the free plan; Flaxia+ raises both the count to MAX_ATTACHMENTS_PLUS and
 * the byte caps to the shared upload limits).
 * Game payloads (zip / swf / html) are NOT part of this system — they keep
 * using the legacy gif_key / payload_key / swf_key / thumbnail_key columns.
 *
 * R2 key layout: {bucketPrefix}/{postId}/{position}{ext}
 *   bucketPrefix: gif (images) | audio | video | docs (pdf)
 */

import { GAME_FILE_EXTENSIONS } from '../../shared/file-extensions.ts';
import {
  FREE_MEDIA_TOTAL_BYTES,
  FREE_UPLOAD_MAX_BYTES,
  PLUS_MEDIA_TOTAL_BYTES,
  PLUS_UPLOAD_MAX_BYTES,
} from '../../shared/upload-limits.ts';
import { enrichPostsWithAiIndex } from './ai-index.ts';
import { getUserPlan } from './billing.ts';
import type { Db } from './ports/index.ts';

export type AttachmentKind = 'image' | 'audio' | 'video' | 'document';

/** Free-plan ceiling. */
export const MAX_ATTACHMENTS = 4;
/** Flaxia+ ceiling. Also the hard cap baked into R2 key slots. */
export const MAX_ATTACHMENTS_PLUS = 32;
/** Default (free) per-file and per-post media budgets. Flaxia+ callers pass
 * the larger shared limits into `sumAttachmentSizes`. */
export const MAX_ATTACHMENT_FILE_BYTES = FREE_UPLOAD_MAX_BYTES;
export const MAX_ATTACHMENT_TOTAL_BYTES = FREE_MEDIA_TOTAL_BYTES;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'opus'] as const;
const VIDEO_EXTS = ['mp4', 'webm', 'mov'] as const;

/** Game containers keep the legacy composer flow; they are never attachments. */
const GAME_EXTS = new Set(['zip', 'swf', 'html', 'htm']);

const KIND_PREFIX: Record<AttachmentKind, string> = {
  image: 'gif',
  audio: 'audio',
  video: 'video',
  document: 'docs',
};

/**
 * Reverse of KIND_PREFIX, derived so a new kind can never silently fall
 * through to a wrong bucket in parseAttachmentKey. Keys are the only source
 * of truth for a kind at read time (the client sends only a key + kind).
 */
const PREFIX_KIND = new Map<string, AttachmentKind>(
  (Object.entries(KIND_PREFIX) as [AttachmentKind, string][]).map(([kind, prefix]) => [prefix, kind]),
);

const EXT_MAP: Record<string, string> = {
  png: '.png',
  jpg: '.jpg',
  jpeg: '.jpg',
  gif: '.gif',
  webp: '.webp',
  mp3: '.mp3',
  wav: '.wav',
  ogg: '.ogg',
  m4a: '.m4a',
  opus: '.opus',
  mp4: '.mp4',
  webm: '.webm',
  mov: '.mov',
};

/** Matches multi-media attachment keys: gif|audio|video|docs/{postId}/{1-32}{ext} */
const ATTACHMENT_KEY_RE = /^(gif|audio|video|docs)\/([^/]+)\/(\d{1,2})(\.[A-Za-z0-9]+)$/;

export function normalizeExt(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.(\w+)$/)?.[1];
  if (!ext) return 'bin';
  return EXT_MAP[ext]?.slice(1) ?? (/^[a-z0-9]{1,8}$/.test(ext) ? ext : null);
}

/**
 * Resolve the attachment kind for an upload. Unrecognized extensions use the
 * document slot and are served as downloads; executable game formats retain
 * their dedicated legacy flow in the composer.
 *
 * `contentType` disambiguates .webm (audio vs video).
 */
export function kindFromUpload(filename: string, contentType?: string): AttachmentKind | null {
  const ext = filename.toLowerCase().match(/\.(\w+)$/)?.[1];
  if (!ext) return 'document';
  if (GAME_FILE_EXTENSIONS.has(ext)) return null;

  if (GAME_EXTS.has(ext)) return null;

  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return 'image';

  if (ext === 'webm') {
    return contentType?.toLowerCase().startsWith('audio/') ? 'audio' : 'video';
  }

  if ((AUDIO_EXTS as readonly string[]).includes(ext)) return 'audio';
  if ((VIDEO_EXTS as readonly string[]).includes(ext)) return 'video';
  return 'document';
}

export function buildAttachmentKey(
  postId: string,
  position: number,
  filename: string,
  contentType?: string,
): string | null {
  // contentType must reach kindFromUpload so the key prefix matches the kind
  // reported to the client (.webm can be audio or video).
  const kind = kindFromUpload(filename, contentType);
  if (!kind) return null;
  const ext = normalizeExt(filename);
  if (!ext) return null;
  if (!Number.isInteger(position) || position < 1 || position > MAX_ATTACHMENTS_PLUS) return null;
  return `${KIND_PREFIX[kind]}/${postId}/${position}.${ext || 'bin'}`;
}

export function parseAttachmentKey(
  key: string,
): { postId: string; position: number; kind: AttachmentKind; ext: string } | null {
  const m = ATTACHMENT_KEY_RE.exec(key);
  if (!m) return null;
  const prefix = m[1];
  const position = Number(m[3]);
  if (!Number.isInteger(position) || position < 1 || position > MAX_ATTACHMENTS_PLUS) return null;
  const kind = PREFIX_KIND.get(prefix);
  if (!kind) return null;
  const ext = m[4];
  // Game containers must never be addressable as attachments, even when the
  // key is crafted by hand instead of produced by buildAttachmentKey.
  if (GAME_EXTS.has(ext.slice(1).toLowerCase())) return null;
  return { postId: m[2], position, kind, ext };
}

export interface AttachmentInput {
  key: string;
  kind?: string;
}

export interface AttachmentRecord {
  r2_key: string;
  kind: AttachmentKind;
  position: number;
}

/**
 * Validate a client-supplied attachment list (order = position).
 * `max` is the plan-dependent ceiling resolved by the caller (defaults to the
 * free-plan limit so existing callers stay safe).
 * Returns an error message, or null when valid.
 */
export function validateAttachmentInputs(inputs: unknown, max: number = MAX_ATTACHMENTS): string | null {
  if (!Array.isArray(inputs)) return 'attachments must be an array';
  if (inputs.length === 0) return 'attachments must not be empty';
  if (inputs.length > max) return `Maximum ${max} attachments allowed`;

  const seenPositions = new Set<number>();
  for (const item of inputs as AttachmentInput[]) {
    if (!item || typeof item.key !== 'string') return 'Invalid attachment entry';
    const parsed = parseAttachmentKey(item.key);
    if (!parsed) return `Invalid attachment key: ${item.key}`;
    if (item.kind !== undefined && item.kind !== parsed.kind) {
      return `Attachment kind mismatch for ${item.key}`;
    }
    if (seenPositions.has(parsed.position)) return 'Duplicate attachment position';
    seenPositions.add(parsed.position);
  }
  return null;
}

/** Re-sequence positions 1..N following the given key order. */
export function sequenceAttachments(inputs: AttachmentInput[]): AttachmentRecord[] {
  return inputs.map((item, index) => {
    const parsed = parseAttachmentKey(item.key)!;
    return { r2_key: item.key, kind: parsed.kind, position: index + 1 };
  });
}

/** Total byte size of an attachment list, verified against R2 metadata. */
export async function sumAttachmentSizes(
  bucket: R2Bucket,
  keys: string[],
  limits: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<{ total: number; error: string | null }> {
  const maxFileBytes = limits.maxFileBytes ?? MAX_ATTACHMENT_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES;
  let total = 0;
  for (const key of keys) {
    const head = await bucket.head(key);
    if (!head) return { total, error: `Attachment not found in storage: ${key}` };
    if (head.size > maxFileBytes) {
      return { total, error: `File too large. Maximum size is ${maxFileBytes / (1024 * 1024)}MB` };
    }
    total += head.size;
  }
  if (total > maxTotalBytes) {
    return {
      total,
      error: `Attachments exceed ${maxTotalBytes / (1024 * 1024)}MB total limit`,
    };
  }
  return { total, error: null };
}

/**
 * Plan-aware attachment budget: Flaxia+ gets 128MB per file / 256MB total,
 * everyone else keeps 25MB / 50MB. Returns an error string or null.
 */
export async function attachmentBudget(
  env: { DB: Db; BUCKET: R2Bucket },
  userId: string,
  keys: string[],
): Promise<string | null> {
  const plan = await getUserPlan({ DB: env.DB }, userId);
  const limits = plan.isActive
    ? { maxFileBytes: PLUS_UPLOAD_MAX_BYTES, maxTotalBytes: PLUS_MEDIA_TOTAL_BYTES }
    : undefined;
  return (await sumAttachmentSizes(env.BUCKET, keys, limits)).error;
}

export interface AttachmentsEnrichable {
  id: string;
}

/**
 * Batch-load attachments for a list of posts and attach them as
 * `post.attachments` (ordered by position). Mirrors the other enrich*
 * helpers used by timeline/thread endpoints.
 */
export async function enrichPostsWithAttachments<T extends AttachmentsEnrichable>(
  posts: T[],
  db: D1Database,
): Promise<void> {
  if (posts.length === 0) return;
  try {
    const ids = posts.map((p) => p.id);
    const placeholders = ids.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT post_id, r2_key, kind, position FROM post_attachments
         WHERE post_id IN (${placeholders}) ORDER BY position ASC`,
      )
      .bind(...ids)
      .all<{ post_id: string; r2_key: string; kind: AttachmentKind; position: number }>();

    const byPost = new Map<string, AttachmentRecord[]>();
    for (const row of result.results || []) {
      const list = byPost.get(row.post_id) || [];
      list.push({ r2_key: row.r2_key, kind: row.kind, position: row.position });
      byPost.set(row.post_id, list);
    }
    for (const post of posts) {
      const list = byPost.get(post.id);
      (post as Record<string, unknown>).attachments = list ? list : [];
    }
    await enrichPostsWithAiIndex(posts, db);
  } catch (e) {
    console.error('Failed to enrich posts with attachments:', e);
  }
}

/** Every image key in an attachment list (audio/video/documents are never screened). */
export function imageAttachmentKeys(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  const keys: string[] = [];
  for (const item of attachments as AttachmentRecord[]) {
    if (item?.kind === 'image' && typeof item.r2_key === 'string') keys.push(item.r2_key);
  }
  return keys;
}

/** Delete attachment rows for a post (and optionally its descendant replies). */
export async function deleteAttachmentRows(db: D1Database, postIds: string[]): Promise<void> {
  if (postIds.length === 0) return;
  const placeholders = postIds.map(() => '?').join(',');
  await db
    .prepare(`DELETE FROM post_attachments WHERE post_id IN (${placeholders})`)
    .bind(...postIds)
    .run();
}

/** Collect all r2 keys of the given posts' attachments. */
export async function collectAttachmentKeys(db: D1Database, postIds: string[]): Promise<string[]> {
  if (postIds.length === 0) return [];
  const placeholders = postIds.map(() => '?').join(',');
  const result = await db
    .prepare(`SELECT r2_key FROM post_attachments WHERE post_id IN (${placeholders})`)
    .bind(...postIds)
    .all<{ r2_key: string }>();
  return (result.results || []).map((r) => r.r2_key);
}
