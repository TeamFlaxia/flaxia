// Pure media helpers shared by the Svelte carousel, stage and document cards.
// Kept free of DOM access so unit tests can import this module directly.
import type { PostAttachment } from '../../../shared/types/post.ts';
import { nativeApiHref } from '../native-api.ts';

/** Remote ActivityPub media keeps its absolute URL and is loaded directly. */
export function isAbsoluteMediaUrl(key: string): boolean {
  return /^https?:\/\//i.test(key);
}

/**
 * R2 key → browser URL for an attachment.
 *
 * The `image` branch is a deliberate fallback rather than a `default:` case so
 * that a kind added to MediaAttachmentKind without a URL here fails the build
 * instead of silently 404ing behind an image request.
 */
export function attachmentUrl(att: PostAttachment): string {
  if (isAbsoluteMediaUrl(att.r2_key)) return att.r2_key;
  switch (att.kind) {
    case 'audio':
      return nativeApiHref(`/api/audio/${att.r2_key}`);
    case 'video':
      return nativeApiHref(`/api/video/${att.r2_key}`);
    case 'document':
      return nativeApiHref(`/api/documents/${att.r2_key}`);
    case 'image':
      return nativeApiHref(`/api/images/${att.r2_key}`);
  }
}

/** Last path segment, without a query string: the displayed filename. */
export function mediaBaseName(keyOrUrl: string): string {
  const path = keyOrUrl.split('?')[0];
  return path.split('/').pop() || 'file';
}

/**
 * Download name for a document attachment. The original filename is not
 * stored in R2, so prefix the post id segment to keep downloads distinct.
 */
export function mediaFileName(keyOrUrl: string): string {
  const path = keyOrUrl.split('?')[0];
  const parts = path.split('/');
  const base = parts.pop() || 'file';
  const parent = parts.pop() || '';
  return parent ? `${parent}-${base}` : base;
}
