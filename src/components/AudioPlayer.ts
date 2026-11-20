// Legacy-compatible bridge: the audio player UI is owned by
// AudioPlayer.svelte. This module keeps the data-saver/error fallbacks and the
// media-cue overlay so existing callers keep working unchanged.
import { mount, unmount } from 'svelte';
import { GifPreviewProps } from '../../shared/types/post.ts';
import { createDataSaverPlaceholder } from '../lib/data-saver.js';
import { t } from '../lib/i18n.js';
import { nativeApiHref } from '../lib/native-api.js';
import { isDataSaverEnabled } from '../lib/settings.js';
import AudioPlayer from '../lib/svelte/AudioPlayer.svelte';
import { createMediaCueOverlay } from './MediaCues.js';

export function createAudioPlayer(props: GifPreviewProps): HTMLElement {
  // Data-saver: don't fetch audio bytes until the user taps.
  if (!props.src && !props.dataSaverConfirmed && isDataSaverEnabled()) {
    const placeholder = createDataSaverPlaceholder(t('media.data_saver_load_audio'), () => {
      const real = createAudioPlayer({ ...props, dataSaverConfirmed: true });
      placeholder.replaceWith(real);
    });
    placeholder.classList.add('audio-player');
    return placeholder;
  }

  const target = document.createElement('div');

  if (!props.gifKey && !props.src) {
    const container = document.createElement('div');
    container.className = 'audio-player';
    container.tabIndex = 0;
    const fallback = document.createElement('div');
    fallback.className = 'audio-player-error';
    fallback.textContent = t('audio.no_audio');
    container.appendChild(fallback);
    target.appendChild(container);
    return target;
  }

  const audioUrl = nativeApiHref(props.src || `/api/audio/${props.gifKey || ''}`);
  const cueOverlay = createMediaCueOverlay(props.cues);

  const instance = mount(AudioPlayer, {
    target,
    props: {
      audioUrl,
      cueElement: cueOverlay?.element ?? null,
      onCueTime: (time: number) => cueOverlay?.update(time),
    },
  });

  // Mirrors the legacy DOMNodeRemoved teardown: drop the Svelte subtree and
  // the cue overlay when the stage/carousel removes the player from the DOM.
  const observer = new MutationObserver(() => {
    if (target.isConnected) return;
    observer.disconnect();
    cueOverlay?.destroy();
    unmount(instance);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return target;
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  if (props.gifKey && props.gifKey.startsWith('audio/')) {
    return createAudioPlayer(props);
  }

  const container = document.createElement('div');
  container.className = 'image-preview';

  if (!props.gifKey) {
    const fallback = document.createElement('div');
    fallback.className = 'image-preview-error';
    fallback.textContent = t('image_preview.no_preview');
    container.appendChild(fallback);
    return container;
  }

  const img = document.createElement('img');
  img.className = 'image-preview-img';
  img.alt = t('image_preview.post_preview', { id: props.postId });
  img.loading = 'lazy';

  if (props.src) {
    img.src = props.src;
  } else {
    img.src = nativeApiHref(`/api/images/${props.gifKey}?_=${Date.now()}`);
  }

  img.onerror = () => {
    img.style.display = 'none';
    const fallback = document.createElement('div');
    fallback.className = 'image-preview-error';
    fallback.textContent = t('image_preview.load_failed');
    container.appendChild(fallback);
  };

  container.appendChild(img);
  return container;
}
