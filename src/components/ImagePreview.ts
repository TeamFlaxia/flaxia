import { mount, unmount } from 'svelte';
import type { GifPreviewProps } from '../../shared/types/post.ts';
import { t } from '../lib/i18n.js';
import { openImageLightbox } from '../lib/media/image-lightbox.ts';
import { nativeApiHref } from '../lib/native-api.js';
import { isDataSaverEnabled } from '../lib/settings.js';
import ImagePreview from '../lib/svelte/ImagePreview.svelte';
import DataSaverPlaceholder from '../lib/svelte/media/DataSaverPlaceholder.svelte';
import MediaFallback from '../lib/svelte/media/MediaFallback.svelte';

export function createImagePreview(props: GifPreviewProps): HTMLElement {
  const target = document.createElement('div');
  let instance: ReturnType<typeof mount> | undefined;
  let observer: MutationObserver | undefined;

  // Whichever root is mounted below gets one shared removal observer. The
  // data-saver gate used to return before reaching it, leaving its Svelte root
  // (and any document listeners) alive when a card was removed untapped.
  const watchForRemoval = () => {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (target.isConnected) return;
      observer?.disconnect();
      if (instance) {
        unmount(instance);
        instance = undefined;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };

  // Data-saver: don't fetch image bytes until the user taps.
  if (!props.src && !props.dataSaverConfirmed && isDataSaverEnabled()) {
    target.className = 'image-preview';
    instance = mount(DataSaverPlaceholder, {
      target,
      props: {
        label: t('media.data_saver_load_image'),
        onLoad: () => {
          const real = createImagePreview({ ...props, dataSaverConfirmed: true });
          target.replaceWith(real);
          // The observer will also see this removal; clear the tracked root so
          // it is not unmounted twice once that callback fires, and stop
          // observing a target that is no longer in the document.
          observer?.disconnect();
          observer = undefined;
          if (instance) {
            unmount(instance);
            instance = undefined;
          }
        },
      },
    });
    watchForRemoval();
    return target;
  }

  if (!props.gifKey && !props.src) {
    instance = mount(MediaFallback, {
      target,
      props: { message: t('image_preview.no_preview') },
    });
    watchForRemoval();
    return target;
  }

  const imageUrl =
    props.src || nativeApiHref(props.isThumbnail ? `/api/thumbnail/${props.postId}` : `/api/images/${props.gifKey}`);
  const baseImageUrl = imageUrl;

  instance = mount(ImagePreview, {
    target,
    props: {
      imageUrl,
      baseImageUrl,
      postId: props.postId,
      alt: t('image_preview.post_preview', { id: props.postId }),
      ratio: props.ratio,
      fit: props.fit,
      isThumbnail: props.isThumbnail,
      simple: !!props.src,
      // Even when `src` is a direct URL (remote media / attachments), the
      // preview must open the fullscreen viewer on click.
      onOpenOverlay: () => {
        createImageOverlay(imageUrl, props.postId, props.gallery, props.galleryIndex ?? 0);
      },
    },
  });

  watchForRemoval();

  return target;
}

/**
 * Fullscreen lightbox bridge. The zoom/pan/gallery UI lives in
 * ImageLightbox.svelte; this adapter only owns the exit animation and unmount.
 */
function createImageOverlay(imageUrl: string, postId: string, gallery?: string[], galleryIndex = 0): void {
  openImageLightbox(imageUrl, postId, gallery, galleryIndex);
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  return createImagePreview(props);
}
