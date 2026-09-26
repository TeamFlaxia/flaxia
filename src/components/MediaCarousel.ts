import type { PostAttachment } from '../types/post.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { createDocumentViewer } from './DocumentViewer.js';
import { createImagePreview } from './ImagePreview.js';
import { createVideoPlayer } from './VideoPlayer.js';

export interface MediaCarouselProps {
  postId: string;
  attachments: PostAttachment[];
}

/**
 * R2 key → browser URL for an attachment.
 *
 * The `image` branch is a deliberate fallback rather than a `default:` case so
 * that a kind added to MediaAttachmentKind without a URL here fails the build
 * instead of silently 404ing behind an image request.
 */
export function attachmentUrl(att: PostAttachment): string {
  switch (att.kind) {
    case 'audio':
      return `/api/audio/${att.r2_key}`;
    case 'video':
      return `/api/video/${att.r2_key}`;
    case 'document':
      return `/api/documents/${att.r2_key}`;
    case 'image':
      return `/api/images/${att.r2_key}`;
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

  const imageKeys = props.attachments.filter((a) => a.kind === 'image').map((a) => a.r2_key);
  let imageIndex = 0;

  for (const att of props.attachments) {
    const slide = document.createElement('div');
    slide.className = 'media-carousel-slide';

    if (att.kind === 'image') {
      const galleryIndex = imageIndex++;
      slide.appendChild(
        createImagePreview({
          gifKey: att.r2_key,
          postId: props.postId,
          gallery: imageKeys,
          galleryIndex,
        }),
      );
    } else if (att.kind === 'video') {
      slide.appendChild(createVideoPlayer({ gifKey: att.r2_key, postId: props.postId }));
    } else if (att.kind === 'document') {
      slide.appendChild(createDocumentViewer({ r2Key: att.r2_key }));
    } else {
      slide.appendChild(createAudioPlayer({ gifKey: att.r2_key, postId: props.postId }));
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
        });
      },
      { passive: true },
    );

    root.appendChild(dots);
  }

  return root;
}
