// Legacy-compatible bridge: the carousel UI is owned by MediaCarousel.svelte.
// Pure URL helpers stay exported here for RemoteProfilePage and unit tests.
import { mount, unmount } from 'svelte';
import type { MediaCue } from '../../shared/post-cues.ts';
import type { PostAttachment } from '../../shared/types/post.ts';
import { attachmentUrl, isAbsoluteMediaUrl } from '../lib/media/attachments.ts';
import MediaCarousel from '../lib/svelte/media/MediaCarousel.svelte';

export { attachmentUrl, isAbsoluteMediaUrl };

export interface MediaCarouselProps {
  postId: string;
  attachments: PostAttachment[];
  /** Timed comments parsed from the owning post's body, applied to every video/audio slide. */
  cues?: MediaCue[];
}

export interface MediaSlideModel {
  kind: PostAttachment['kind'];
  src: string;
  gifKey: string;
  gallery?: string[];
  galleryIndex?: number;
}

/**
 * One view model per attachment. Remote ActivityPub media keeps its absolute
 * URL; only local images participate in the lightbox gallery.
 */
export function buildMediaSlides(props: MediaCarouselProps): MediaSlideModel[] {
  const imageKeys = props.attachments
    .filter((a) => a.kind === 'image' && !isAbsoluteMediaUrl(a.r2_key))
    .map((a) => a.r2_key);
  let imageIndex = 0;

  return props.attachments.map((att) => {
    const remote = isAbsoluteMediaUrl(att.r2_key);
    if (att.kind === 'image') {
      const galleryIndex = remote ? undefined : imageIndex++;
      return {
        kind: att.kind,
        src: attachmentUrl(att),
        gifKey: att.r2_key,
        gallery: remote ? undefined : imageKeys,
        galleryIndex,
      };
    }
    return { kind: att.kind, src: attachmentUrl(att), gifKey: att.r2_key };
  });
}

/**
 * Horizontal scroll-snap carousel rendering every media attachment of a post:
 * images, videos, audio players and PDF viewers side by side with page dots.
 */
export function createMediaCarousel(props: MediaCarouselProps): HTMLElement {
  const root = document.createElement('div');
  const instance = mount(MediaCarousel, {
    target: root,
    props: {
      postId: props.postId,
      slides: buildMediaSlides(props),
      cues: props.cues,
    },
  });

  // Legacy callers only append/remove the returned element; unmount the Svelte
  // subtree (and its cue overlays) when it leaves the document.
  const observer = new MutationObserver(() => {
    if (root.isConnected) return;
    observer.disconnect();
    unmount(instance);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return root;
}
