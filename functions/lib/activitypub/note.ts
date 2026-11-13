/// <reference types="@cloudflare/workers-types" />

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
  type: 'Document' | 'Image';
  mediaType: string;
  url: string;
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
  mentions?: Array<{ username: string; url?: string; domain?: string }>;
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
export function buildNoteObject(
  post: NoteInput,
  user: NoteUser,
  baseUrl: string,
  options: AudienceOptions & { mentionHandles?: Record<string, string> } = { followersUrl: '' },
): NoteObject {
  const followersUrl = options.followersUrl || `${actorUrl(baseUrl, user.username)}/followers`;
  const actor = actorUrl(baseUrl, user.username);
  const id = noteUrl(baseUrl, post.id);

  const mentionUrls = (post.mentions ?? [])
    .map((mention) => mention.url)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);

  const { to, cc } = audienceFor(post.visibility ?? 'public', { followersUrl, mentionUrls });

  const mentionHandles: Record<string, string> = { ...(options.mentionHandles ?? {}) };
  for (const mention of post.mentions ?? []) {
    if (!mention.url) continue;
    const key = mention.domain ? `${mention.username}@${mention.domain}` : mention.username;
    mentionHandles[key] = mention.url;
  }

  const tags: NoteTag[] = [];
  for (const mention of post.mentions ?? []) {
    const href = mention.url ?? (mention.domain ? undefined : profileUrl(baseUrl, mention.username));
    if (!href) continue;
    tags.push({
      type: 'Mention',
      name: mention.domain ? `@${mention.username}@${mention.domain}` : `@${mention.username}`,
      href,
    });
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
    published: new Date().toISOString(),
  };
}
