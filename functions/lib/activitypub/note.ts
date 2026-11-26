import { actorUrl, noteUrl, profileUrl } from './actor.ts';
import { activityContext, PUBLIC_COLLECTION } from './context.ts';
import { extractHashtags, textToHtml } from './text.ts';

/**
 * Federated Note objects.
 *
 * A Note is the object Flaxia publishes for a post. It carries the audience
 * (`to`/`cc`), the mentions and hashtags as `tag` entries, the attachments as
 * `attachment` entries and the reply link. Everything a peer needs to render
 * the post lives in the object, so no extra fetches are required.
 */

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct';

export interface NoteTag {
  type: 'Mention' | 'Hashtag';
  name: string;
  href: string;
}

export interface NoteAttachment {
  type: 'Document' | 'Image' | 'Audio' | 'Video' | 'Link';
  mediaType?: string;
  url?: string;
  href?: string;
  name?: string;
}

export interface NoteUser {
  id: string;
  username: string;
  display_name: string | null;
}

export interface NoteInput {
  id: string;
  text: string;
  created_at: string;
  visibility?: Visibility;
  parent_id?: string | null;
  root_id?: string | null;
  sensitive?: boolean;
  attachments?: NoteAttachment[];
  /** Mentioned accounts: local ones carry a username, remote ones an actor URL. */
  mentions?: Array<{ username: string; url?: string; domain?: string; name?: string }>;
}

export interface NoteObject {
  '@context': string[];
  id: string;
  type: 'Note';
  attributedTo: string;
  content: string;
  published: string;
  url: string;
  to: string[];
  cc: string[];
  tag?: NoteTag[];
  attachment?: NoteAttachment[];
  inReplyTo?: string;
  replies?: { id: string; type: string; collection: { id: string; type: string; totalItems: number } };
  sensitive?: boolean;
  source?: { content: string; mediaType: string };
}

export interface AudienceOptions {
  followersUrl: string;
  mentionUrls?: string[];
}

/**
 * Map a visibility to the ActivityPub audience.
 *
 * `public` reaches the whole network, `unlisted` only the followers of the
 * author, `private` the followers of the author without the public marker and
 * `direct` the mentioned accounts only.
 */
export function audienceFor(
  visibility: Visibility,
  { followersUrl, mentionUrls = [] }: AudienceOptions,
): {
  to: string[];
  cc: string[];
} {
  const mentions = mentionUrls.filter((url) => url && url !== followersUrl);
  switch (visibility) {
    case 'unlisted':
      return { to: [followersUrl, ...mentions], cc: [PUBLIC_COLLECTION] };
    case 'private':
      return { to: [followersUrl, ...mentions], cc: [] };
    case 'direct':
      return { to: [...mentions], cc: [] };
    default:
      // public
      return { to: [PUBLIC_COLLECTION], cc: [followersUrl, ...mentions] };
  }
}

/**
 * Build the Note object of a post.
 */

interface AttachmentRow {
  r2_key: string;
  kind: string;
}

/** Structural D1 surface (keeps this module free of platform-specific types). */
interface AttachmentDb {
  prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
}

const ATTACHMENT_BUCKETS: Record<string, string> = {
  image: 'images',
  audio: 'audio',
  video: 'video',
  document: 'documents',
};

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
};

function mediaTypeOf(key: string): string {
  const ext = (key.split('?')[0].split('.').pop() ?? '').toLowerCase();
  return MEDIA_TYPES[ext] ?? 'application/octet-stream';
}

function fileNameOf(key: string): string {
  return decodeURIComponent(key.split('?')[0].split('/').pop() ?? 'attachment');
}

function noteTypeFor(kind: string): NoteAttachment['type'] {
  if (kind === 'image') return 'Image';
  if (kind === 'audio') return 'Audio';
  if (kind === 'video') return 'Video';
  return 'Document';
}

function absoluteMediaUrl(baseUrl: string, kind: string, key: string): string {
  if (/^https?:\/\//i.test(key)) return key;
  return `${baseUrl}/api/${ATTACHMENT_BUCKETS[kind] ?? 'documents'}/${key}`;
}

/**
 * Build the `attachment` list for a Note: images/audio/video point at the
 * original file, game payloads become a single link to the Arcade screen
 * (remote instances must never embed or execute our game archives).
 */
export async function loadNoteAttachments(
  db: AttachmentDb,
  postId: string,
  baseUrl: string,
  media: {
    gif_key?: string | null;
    payload_key?: string | null;
    swf_key?: string | null;
  } = {},
): Promise<NoteAttachment[]> {
  const attachments: NoteAttachment[] = [];
  try {
    const rows = await db
      .prepare('SELECT r2_key, kind FROM post_attachments WHERE post_id = ? ORDER BY position ASC')
      .bind(postId)
      .all<AttachmentRow>();
    for (const row of rows.results ?? []) {
      attachments.push({
        type: noteTypeFor(row.kind),
        mediaType: mediaTypeOf(row.r2_key),
        url: absoluteMediaUrl(baseUrl, row.kind, row.r2_key),
        name: fileNameOf(row.r2_key),
      });
    }
  } catch {
    // Attachments are optional; a failed lookup must not block delivery.
  }

  const gif = media.gif_key ?? '';
  if (gif && attachments.length === 0) {
    const kind = gif.startsWith('audio/') ? 'audio' : gif.startsWith('video/') ? 'video' : 'image';
    attachments.push({
      type: noteTypeFor(kind),
      mediaType: mediaTypeOf(gif),
      url: absoluteMediaUrl(baseUrl, kind, gif),
      name: fileNameOf(gif),
    });
  }

  if (media.payload_key || media.swf_key) {
    const arcadeUrl = `${baseUrl}/arcade/${encodeURIComponent(postId)}`;
    attachments.push({
      type: 'Link',
      mediaType: 'text/html',
      href: arcadeUrl,
      url: arcadeUrl,
      name: 'Play on Flaxia',
    });
  }

  return attachments;
}

export function buildNoteObject(
  post: NoteInput,
  user: NoteUser,
  baseUrl: string,
  options: AudienceOptions & { mentionHandles?: Record<string, string> } = { followersUrl: '' },
): NoteObject {
  const followersUrl = options.followersUrl || `${actorUrl(baseUrl, user.username)}/followers`;
  const actor = actorUrl(baseUrl, user.username);
  const id = noteUrl(baseUrl, post.id);

  // Stored mention URLs are actor documents from remote instances. Only http(s)
  // URLs may become audience entries, tags or link targets.
  const isHttpUrl = (value: string): boolean => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  };
  const mentionUrls = [
    ...new Set(
      (post.mentions ?? [])
        .map((mention) => mention.url)
        .filter((url): url is string => typeof url === 'string' && isHttpUrl(url)),
    ),
  ];

  const { to, cc } = audienceFor(post.visibility ?? 'public', { followersUrl, mentionUrls });

  const mentionHandles: Record<string, string> = { ...(options.mentionHandles ?? {}) };
  for (const mention of post.mentions ?? []) {
    if (!mention.url || !isHttpUrl(mention.url)) continue;
    const key = mention.domain ? `${mention.username}@${mention.domain}` : mention.username;
    mentionHandles[key] = mention.url;
  }

  const tags: NoteTag[] = [];
  const seenTags = new Set<string>();
  for (const mention of post.mentions ?? []) {
    const href =
      mention.url && isHttpUrl(mention.url)
        ? mention.url
        : mention.domain
          ? undefined
          : profileUrl(baseUrl, mention.username);
    if (!href) continue;
    const name = mention.domain ? `@${mention.username}@${mention.domain}` : `@${mention.username}`;
    const tagKey = `Mention:${name}:${href}`;
    if (seenTags.has(tagKey)) continue;
    seenTags.add(tagKey);
    tags.push({ type: 'Mention', name, href });
  }
  for (const hashtag of extractHashtags(post.text)) {
    tags.push({
      type: 'Hashtag',
      name: `#${hashtag}`,
      href: `${baseUrl}/tags/${encodeURIComponent(hashtag)}`,
    });
  }

  const note: NoteObject = {
    '@context': activityContext(),
    id,
    type: 'Note',
    attributedTo: actor,
    content: textToHtml(post.text, baseUrl, mentionHandles),
    published: post.created_at,
    url: id,
    to,
    cc,
  };

  if (tags.length > 0) note.tag = tags;
  if (post.attachments && post.attachments.length > 0) note.attachment = post.attachments;
  if (post.parent_id) note.inReplyTo = noteUrl(baseUrl, post.parent_id);
  if (post.parent_id) {
    note.replies = {
      id: `${id}/replies`,
      type: 'Collection',
      collection: { id: `${id}/replies`, type: 'Collection', totalItems: 0 },
    };
  }
  if (post.sensitive) note.sensitive = true;

  return note;
}

/**
 * Wrap a Note in a Create activity.
 */
export function buildCreateActivity(note: NoteObject, user: NoteUser, baseUrl: string): Record<string, unknown> {
  const actor = actorUrl(baseUrl, user.username);
  const postId = note.id.split('/notes/')[1] ?? note.id;
  return {
    '@context': activityContext(),
    id: `${baseUrl}/activities/create-${postId}`,
    type: 'Create',
    actor,
    object: note,
    to: note.to ?? [],
    cc: note.cc ?? [],
    // The Create carries the Note's own timestamp: peers use it to order the
    // activity, and an outbox page must not claim every post was created at
    // the moment the page was requested.
    published: note.published,
  };
}
