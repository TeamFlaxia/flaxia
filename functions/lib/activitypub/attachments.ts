// Inbound ActivityPub attachment parsing.
//
// Remote media is referenced by URL, never copied. Images/audio/video render
// inline; games and other archives become link-only documents so a remote
// instance can never execute code in a Flaxia surface.
export type RemoteAttachmentKind = 'image' | 'audio' | 'video' | 'document';
export interface RemoteAttachment {
  url: string;
  kind: RemoteAttachmentKind;
}

interface IncomingNoteAttachment {
  type?: string | string[];
  mediaType?: string;
  url?: unknown;
  remote_url?: unknown;
  name?: string;
}

/** Mastodon REST uses lower-case types; ActivityPub uses capitalized ones. */
const TYPE_HINTS: Record<string, string> = {
  image: 'image/',
  video: 'video/',
  gifv: 'video/',
  audio: 'audio/',
};

function mediaTypeHint(record: IncomingNoteAttachment): string {
  if (typeof record.mediaType === 'string' && record.mediaType) return record.mediaType;
  const types = Array.isArray(record.type) ? record.type : [record.type];
  for (const type of types) {
    if (typeof type !== 'string') continue;
    const hint = TYPE_HINTS[type.toLowerCase()];
    if (hint) return hint;
  }
  return '';
}

/** AP uses `url` as a string or `{ href }`; Mastodon REST can use an array. */
function attachmentUrls(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(attachmentUrls);
  if (value && typeof value === 'object') {
    const href = (value as { href?: unknown }).href;
    return typeof href === 'string' ? [href] : [];
  }
  return [];
}

/** Classify a remote attachment. Games/archives become link-only "documents". */
export function remoteAttachmentKind(mediaType: string, pathname: string): RemoteAttachmentKind {
  const mt = mediaType.toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('video/')) return 'video';
  const ext = (pathname.split('/').pop() || '').split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'opus'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  // zip / html / swf / pdf / anything else: never execute or embed remote code,
  // expose it as a plain link instead.
  return 'document';
}

/**
 * Read a Note's `attachment` entries (inbox/outbox) or a Mastodon REST
 * status's `media_attachments`. Only absolute http(s) URLs are kept; the bytes
 * stay on the origin instance (we never mirror them and never fetch them from
 * the server). Archives stay documents: no remote code is embedded or run.
 */
export function parseRemoteAttachments(object: Record<string, unknown>): RemoteAttachment[] {
  const out: RemoteAttachment[] = [];
  const seen = new Set<string>();
  for (const field of ['attachment', 'media_attachments']) {
    if (!Array.isArray(object[field])) continue;
    for (const item of object[field]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as IncomingNoteAttachment;
      const rawUrls = [...attachmentUrls(record.url), ...attachmentUrls(record.remote_url)];
      for (const rawUrl of rawUrls) {
        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          continue;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
        if (parsed.username || parsed.password) continue;
        if (seen.has(parsed.href)) continue;
        seen.add(parsed.href);
        out.push({
          url: parsed.href,
          kind: remoteAttachmentKind(mediaTypeHint(record), parsed.pathname),
        });
        if (out.length >= 32) return out;
      }
    }
  }
  return out;
}

/** Minimal D1 surface so this module stays free of platform types. */
interface AttachmentDb {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

/** Persist a Note's attachments as remote URL rows (position 1..N). */
export async function storeRemoteAttachments(
  db: AttachmentDb,
  postId: string,
  object: Record<string, unknown>,
): Promise<void> {
  const attachments = parseRemoteAttachments(object);
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    await db
      .prepare('INSERT INTO post_attachments (post_id, r2_key, kind, position) VALUES (?, ?, ?, ?)')
      .bind(postId, attachment.url, attachment.kind, index + 1)
      .run();
  }
}
