/**
 * Shared helpers for multi-media post attachments (image / audio / video).
 *
 * One post can carry up to MAX_ATTACHMENTS files (50MB total, 25MB each).
 * Game payloads (zip / swf / html) are NOT part of this system — they keep
 * using the legacy gif_key / payload_key / swf_key / thumbnail_key columns.
 *
 * R2 key layout: {bucketPrefix}/{postId}/{position}{ext}
 *   bucketPrefix: gif (images) | audio | video
 */

export type AttachmentKind = 'image' | 'audio' | 'video';

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'opus'] as const;
const VIDEO_EXTS = ['mp4', 'webm', 'mov'] as const;

const KIND_PREFIX: Record<AttachmentKind, string> = {
  image: 'gif',
  audio: 'audio',
  video: 'video',
};

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

/** Matches multi-media attachment keys: gif|audio|video/{postId}/{1-4}{ext} */
const ATTACHMENT_KEY_RE = /^(gif|audio|video)\/([^/]+)\/([1-4])(\.[A-Za-z0-9]+)$/;

export function normalizeExt(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.(\w+)$/)?.[1];
  if (!ext) return null;
  return EXT_MAP[ext] ? ext : null;
}

/**
 * Resolve the attachment kind for an upload. Returns null when the file type
 * is not allowed (html, swf, zip, js, unknown, ...).
 *
 * `contentType` disambiguates .webm (audio vs video).
 */
export function kindFromUpload(filename: string, contentType?: string): AttachmentKind | null {
  const ext = filename.toLowerCase().match(/\.(\w+)$/)?.[1];
  if (!ext) return null;

  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return 'image';

  if (ext === 'webm') {
    return contentType?.toLowerCase().startsWith('audio/') ? 'audio' : 'video';
  }

  if ((AUDIO_EXTS as readonly string[]).includes(ext)) return 'audio';
  if ((VIDEO_EXTS as readonly string[]).includes(ext)) return 'video';
  return null;
}

export function buildAttachmentKey(postId: string, position: number, filename: string): string | null {
  const kind = kindFromUpload(filename);
  if (!kind) return null;
  const ext = normalizeExt(filename);
  if (!ext) return null;
  if (!Number.isInteger(position) || position < 1 || position > MAX_ATTACHMENTS) return null;
  return `${KIND_PREFIX[kind]}/${postId}/${position}.${ext}`;
}

export function parseAttachmentKey(
  key: string,
): { postId: string; position: number; kind: AttachmentKind; ext: string } | null {
  const m = ATTACHMENT_KEY_RE.exec(key);
  if (!m) return null;
  const prefix = m[1];
  const position = Number(m[3]);
  if (!Number.isInteger(position) || position < 1 || position > MAX_ATTACHMENTS) return null;
  const kind: AttachmentKind = prefix === 'gif' ? 'image' : prefix === 'audio' ? 'audio' : 'video';
  return { postId: m[2], position, kind, ext: m[4] };
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
 * Returns an error message, or null when valid.
 */
export function validateAttachmentInputs(inputs: unknown): string | null {
  if (!Array.isArray(inputs)) return 'attachments must be an array';
  if (inputs.length === 0) return 'attachments must not be empty';
  if (inputs.length > MAX_ATTACHMENTS) return `Maximum ${MAX_ATTACHMENTS} attachments allowed`;

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
): Promise<{ total: number; error: string | null }> {
  let total = 0;
  for (const key of keys) {
    const head = await bucket.head(key);
    if (!head) return { total, error: `Attachment not found in storage: ${key}` };
    if (head.size > MAX_ATTACHMENT_FILE_BYTES) {
      return { total, error: `File too large. Maximum size is ${MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024)}MB` };
    }
    total += head.size;
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    return {
      total,
      error: `Attachments exceed ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)}MB total limit`,
    };
  }
  return { total, error: null };
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
  } catch (e) {
    console.error('Failed to enrich posts with attachments:', e);
  }
}

/** First image key for a post's attachments (NSFW scan / crowd push). */
export function firstImageKey(attachments: unknown): string | null {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  for (const item of attachments as AttachmentRecord[]) {
    if (item?.kind === 'image' && typeof item.r2_key === 'string') return item.r2_key;
  }
  return null;
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
