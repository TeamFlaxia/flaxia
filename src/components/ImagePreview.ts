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

  // Data-saver: don't fetch image bytes until the user taps.
  if (!props.src && !props.dataSaverConfirmed && isDataSaverEnabled()) {
    target.className = 'image-preview';
    const placeholder = mount(DataSaverPlaceholder, {
      target,
      props: {
        label: t('media.data_saver_load_image'),
        onLoad: () => {
          const real = createImagePreview({ ...props, dataSaverConfirmed: true });
          target.replaceWith(real);
          unmount(placeholder);
        },
      },
    });
    return target;
  }

  if (!props.gifKey && !props.src) {
    mount(MediaFallback, {
      target,
      props: { message: t('image_preview.no_preview') },
    });
    return target;
  }

  const imageUrl =
    props.src || nativeApiHref(props.isThumbnail ? `/api/thumbnail/${props.postId}` : `/api/images/${props.gifKey}`);
  const baseImageUrl = imageUrl;

  const instance = mount(ImagePreview, {
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

  const observer = new MutationObserver(() => {
    if (target.isConnected) return;
    observer.disconnect();
    unmount(instance);
  });
  observer.observe(document.body, { childList: true, subtree: true });

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
