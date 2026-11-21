// Inbound ActivityPub attachment parsing.
//
// Remote media is referenced by URL, never copied. Images/audio/video render
// inline; games and other archives become link-only documents so a remote
// instance can never execute code in a Flaxia surface.
type RemoteAttachmentKind = 'image' | 'audio' | 'video' | 'document';

interface IncomingNoteAttachment {
  type?: string;
  mediaType?: string;
  url?: string | { href?: string };
  name?: string;
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
 * Read the Note's `attachment` entries. Only absolute http(s) URLs are kept;
 * the bytes stay on the origin instance (we never mirror them).
 */
export function parseRemoteAttachments(
  object: Record<string, unknown>,
): Array<{ url: string; kind: RemoteAttachmentKind }> {
  if (!Array.isArray(object.attachment)) return [];
  const out: Array<{ url: string; kind: RemoteAttachmentKind }> = [];
  const seen = new Set<string>();
  for (const item of object.attachment) {
    if (!item || typeof item !== 'object') continue;
    const record = item as IncomingNoteAttachment;
    const rawUrl = typeof record.url === 'string' ? record.url : record.url?.href;
    if (typeof rawUrl !== 'string') continue;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    const typeHint =
      record.mediaType ||
      (record.type === 'Image'
        ? 'image/'
        : record.type === 'Video'
          ? 'video/'
          : record.type === 'Audio'
            ? 'audio/'
            : '');
    out.push({ url: parsed.href, kind: remoteAttachmentKind(typeHint, parsed.pathname) });
    if (out.length >= 32) break;
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
