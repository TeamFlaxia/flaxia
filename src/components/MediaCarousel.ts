import type { MediaCue } from '../../shared/post-cues.ts';
import type { PostAttachment } from '../../shared/types/post.ts';
import { t } from '../lib/i18n.js';
import { nativeApiHref } from '../lib/native-api.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { createDocumentViewer } from './DocumentViewer.js';
import { createImagePreview } from './ImagePreview.js';
import { createVideoPlayer } from './VideoPlayer.js';

export interface MediaCarouselProps {
  postId: string;
  attachments: PostAttachment[];
  /** Timed comments parsed from the owning post's body, applied to every video/audio slide. */
  cues?: MediaCue[];
}

/**
 * R2 key → browser URL for an attachment.
 *
 * The `image` branch is a deliberate fallback rather than a `default:` case so
 * that a kind added to MediaAttachmentKind without a URL here fails the build
 * instead of silently 404ing behind an image request.
 */
/** Remote ActivityPub media keeps its absolute URL and is loaded directly. */
export function isAbsoluteMediaUrl(key: string): boolean {
  return /^https?:\/\//i.test(key);
}

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

/**
 * Horizontal scroll-snap carousel rendering every media attachment of a post:
 * images, videos, audio players and PDF viewers side by side with page dots.
 */
export function createMediaCarousel(props: MediaCarouselProps): HTMLElement {
  const root = document.createElement('div');
  root.className = 'media-carousel';

  const track = document.createElement('div');
  track.className = 'media-carousel-track';

  const imageKeys = props.attachments
    .filter((a) => a.kind === 'image' && !isAbsoluteMediaUrl(a.r2_key))
    .map((a) => a.r2_key);
  let imageIndex = 0;

  for (const att of props.attachments) {
    const slide = document.createElement('div');
    slide.className = 'media-carousel-slide';

    // Image and video slides reserve their 16:9 frame on the slide itself, so
    // the track height is fixed before any child media has loaded.
    if (att.kind === 'image' || att.kind === 'video') {
      slide.classList.add('fx-box');
      slide.style.setProperty('--fx-ratio', '16 / 9');
    }

    if (att.kind === 'image') {
      const remote = isAbsoluteMediaUrl(att.r2_key);
      const galleryIndex = remote ? undefined : imageIndex++;
      slide.appendChild(
        createImagePreview({
          gifKey: att.r2_key,
          src: attachmentUrl(att),
          postId: props.postId,
          gallery: remote ? undefined : imageKeys,
          galleryIndex,
          ratio: '16:9',
        }),
      );
    } else if (att.kind === 'video') {
      slide.appendChild(
        createVideoPlayer({ gifKey: att.r2_key, src: attachmentUrl(att), postId: props.postId, cues: props.cues }),
      );
    } else if (att.kind === 'document') {
      const remote = isAbsoluteMediaUrl(att.r2_key);
      if (!remote && att.r2_key.toLowerCase().endsWith('.pdf')) {
        slide.appendChild(createDocumentViewer({ r2Key: att.r2_key }));
      } else {
        const link = document.createElement('a');
        link.className = 'file-preview-doc-chip';
        link.href = attachmentUrl(att);
        const filename = att.r2_key.split('/').pop()?.split('?')[0] || 'file';
        link.textContent = `▤ ${filename} · ${t(remote ? 'composer.preview_open_document' : 'composer.download_file')}`;
        if (remote) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        } else {
          link.setAttribute('download', '');
        }
        slide.appendChild(link);
      }
    } else {
      slide.appendChild(
        createAudioPlayer({ gifKey: att.r2_key, src: attachmentUrl(att), postId: props.postId, cues: props.cues }),
      );
    }

    track.appendChild(slide);
  }

  root.appendChild(track);

  if (props.attachments.length > 1) {
    const dots = document.createElement('div');
    dots.className = 'media-carousel-dots';
    const dotElements = props.attachments.map((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `media-carousel-dot${i === 0 ? ' media-carousel-dot--active' : ''}`;
      dot.setAttribute('aria-label', `${i + 1} / ${props.attachments.length}`);
      dot.setAttribute('aria-current', i === 0 ? 'true' : 'false');
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
      });
      dots.appendChild(dot);
      return dot;
    });

    track.addEventListener(
      'scroll',
      () => {
        const idx = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
        dotElements.forEach((dot, i) => {
          dot.classList.toggle('media-carousel-dot--active', i === idx);
          dot.setAttribute('aria-current', i === idx ? 'true' : 'false');
        });
      },
      { passive: true },
    );

    root.appendChild(dots);
  }

  return root;
}
