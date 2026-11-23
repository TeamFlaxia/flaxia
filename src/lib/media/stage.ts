// Pure stage classification helpers. The Svelte PostStage component renders
// from these values; nothing here touches the DOM.
import type { Post } from '../../../shared/types/post.ts';

type StagePost = Pick<Post, 'id' | 'attachments' | 'gif_key' | 'payload_key' | 'swf_key' | 'thumbnail_key'>;

// Strip a leading emoji from a translated label so the play overlay can
// pair its own typographic glyph with plain text.
export function stripLeadingEmoji(label: string): string {
  return label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');
}

// A post is a runnable ZIP/HTML5 game when its payload key lives under one of
// the known game prefixes (payload/, zip/, html/, versions/). The latter is set
// once a game has been published as a new version via the rolling-update flow.
export function isZipGame(payloadKey?: string | null): boolean {
  if (!payloadKey) return false;
  return (
    payloadKey.endsWith('.zip') ||
    payloadKey.endsWith('.html') ||
    payloadKey.startsWith('zip/') ||
    payloadKey.startsWith('html/') ||
    payloadKey.startsWith('payload/') ||
    payloadKey.startsWith('versions/')
  );
}

export function hasAttachments(post: StagePost): boolean {
  return (post.attachments ?? []).length > 0;
}

export function canExecuteStage(post: StagePost): boolean {
  return !hasAttachments(post) && Boolean(post.payload_key || post.swf_key);
}

export function mediaSignature(post: StagePost): string {
  const attachments = (post.attachments ?? []).map((attachment) => `${attachment.kind}:${attachment.r2_key}`).join(',');
  return [post.gif_key ?? '', post.payload_key ?? '', post.swf_key ?? '', post.thumbnail_key ?? '', attachments].join(
    '|',
  );
}

export function stageClassFor(post: StagePost): string | null {
  if (hasAttachments(post)) return 'post-stage--carousel';
  if (isZipGame(post.payload_key)) return 'post-stage--zip';
  if (post.swf_key?.startsWith('swf/')) return 'post-stage--flash';
  if (post.gif_key?.startsWith('audio/')) return 'post-stage--audio';
  if (post.gif_key?.startsWith('video/')) return 'post-stage--video';
  if (post.gif_key) return 'post-stage--image';
  if (post.thumbnail_key) return 'post-stage--image-thumb';
  return null;
}

/** ZIP/SWF stages reserve their aspect ratio with fx-box instead of padding. */
export function stageBoxRatio(post: StagePost): string | null {
  if (isZipGame(post.payload_key)) return '16 / 9';
  if (post.swf_key?.startsWith('swf/')) return '4 / 3';
  return null;
}

export function hasStageMedia(post: StagePost): boolean {
  return Boolean(hasAttachments(post) || post.gif_key || post.payload_key || post.swf_key || post.thumbnail_key);
}
