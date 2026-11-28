import { stripPostColors } from '../../shared/post-colors.ts';
import type { PostAttachment } from '../../shared/types/post.ts';

/** Escape text embedded in SSR HTML (attributes and text nodes alike). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function assetUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/api/images/${key}`;
}

const ATTACHMENT_ROUTES: Record<PostAttachment['kind'], string> = {
  image: 'images',
  audio: 'audio',
  video: 'video',
  document: 'documents',
};

/** Remote ActivityPub media is already absolute; local files keep their proxy route. */
function attachmentSource(att: PostAttachment, baseUrl: string): string {
  if (/^https?:\/\//i.test(att.r2_key)) return att.r2_key;
  return `${baseUrl}/api/${ATTACHMENT_ROUTES[att.kind] ?? 'documents'}/${att.r2_key}`;
}

function renderAttachment(att: PostAttachment, baseUrl: string, alt: string): string {
  const src = escapeHtml(attachmentSource(att, baseUrl));
  switch (att.kind) {
    case 'image':
      return `<img class="ssr-post-attachment" src="${src}" alt="${escapeHtml(alt || 'Post image')}" width="1200" height="675" loading="lazy">`;
    case 'video':
      return `<video class="ssr-post-attachment" controls preload="metadata" playsinline width="640" height="360" src="${src}"></video>`;
    case 'audio':
      return `<audio class="ssr-post-attachment" controls preload="metadata" src="${src}"></audio>`;
    case 'document': {
      // Archives (zip/swf) and other documents are links only: never embed
      // remote code in the SSR document.
      const name = att.r2_key.split('?')[0].split('/').pop() || 'file';
      return `<a class="ssr-post-attachment ssr-post-document" href="${src}" target="_blank" rel="noopener noreferrer">📄 ${escapeHtml(name)}</a>`;
    }
  }
}

/** SSR media for both local uploads and remote (ActivityPub) attachments. */
export function renderPostMedia(
  gifKey: string | null,
  thumbnailKey: string | null,
  payloadKey: string | null,
  swfKey: string | null,
  baseUrl: string,
  text?: string,
  attachments?: PostAttachment[],
): string {
  const parts: string[] = [];
  const plainText = text ? stripPostColors(text).replace(/\\\{/g, '{') : '';
  const alt = plainText ? plainText.replace(/\s+/g, ' ').trim().slice(0, 120) : '';

  if (attachments && attachments.length > 0) {
    return attachments.map((att) => renderAttachment(att, baseUrl, alt)).join('\n    ');
  }

  if (gifKey?.startsWith('video/')) {
    const videoUrl = `${baseUrl}/api/video/${escapeHtml(gifKey)}`;
    const poster = thumbnailKey ? ` poster="${escapeHtml(assetUrl(baseUrl, thumbnailKey))}"` : '';
    const mime = gifKey.endsWith('.webm') ? 'video/webm' : gifKey.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    const label = escapeHtml(alt || 'Post video');
    parts.push(
      `<video controls preload="metadata" playsinline width="640" height="360"${poster}>\n    <source src="${videoUrl}" type="${mime}">\n    ${label}\n  </video>`,
    );
  } else if (gifKey && !gifKey.startsWith('audio/')) {
    parts.push(
      `<img src="${escapeHtml(assetUrl(baseUrl, gifKey))}" alt="${escapeHtml(alt || 'Post image')}" width="1200" height="675" loading="lazy">`,
    );
  } else if (thumbnailKey) {
    parts.push(
      `<img src="${escapeHtml(assetUrl(baseUrl, thumbnailKey))}" alt="${escapeHtml(alt || 'Post thumbnail')}" width="800" height="600" loading="lazy">`,
    );
  }
  if (payloadKey || swfKey) {
    parts.push(`<p>🎮 Interactive content available</p>`);
  }
  return parts.join('\n    ');
}
