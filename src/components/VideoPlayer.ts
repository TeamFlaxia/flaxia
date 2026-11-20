// Legacy-compatible bridge: the player UI is owned by VideoPlayer.svelte.
// This module keeps the data-saver/error fallbacks, the media-cue overlay and
// teardown, so every existing caller (which only appends the returned element)
// keeps working unchanged.
import { mount, unmount } from 'svelte';
import type { MediaCue } from '../../shared/post-cues.ts';
import { createDataSaverPlaceholder } from '../lib/data-saver.js';
import { t } from '../lib/i18n.js';
import { nativeApiHref } from '../lib/native-api.js';
import { isDataSaverEnabled } from '../lib/settings.js';
import VideoPlayer from '../lib/svelte/VideoPlayer.svelte';
import { createMediaCueOverlay } from './MediaCues.js';

export interface VideoPlayerProps {
  gifKey: string;
  postId: string;
  src?: string;
  /** Set by the data-saver tap-to-load placeholder once the user tapped. */
  dataSaverConfirmed?: boolean;
  /** Timed comments parsed from the post body (media cues), for the overlay. */
  cues?: MediaCue[];
}

export function createVideoPlayer(props: VideoPlayerProps): HTMLElement {
  if (!props.gifKey && !props.src) {
    const fallback = document.createElement('div');
    fallback.className = 'video-player-error';
    fallback.textContent = t('video_player.no_video');
    return fallback;
  }

  // Data-saver: don't fetch video bytes until the user taps.
  if (!props.dataSaverConfirmed && isDataSaverEnabled()) {
    const placeholder = createDataSaverPlaceholder(t('media.data_saver_load_video'), () => {
      const real = createVideoPlayer({ ...props, dataSaverConfirmed: true });
      placeholder.replaceWith(real);
    });
    placeholder.classList.add('video-player');
    return placeholder;
  }

  const target = document.createElement('div');
  const videoUrl = nativeApiHref(props.src || `/api/video/${props.gifKey}`);
  const cueOverlay = createMediaCueOverlay(props.cues);

  const instance = mount(VideoPlayer, {
    target,
    props: {
      videoUrl,
      cueElement: cueOverlay?.element ?? null,
      onCueTime: (time: number) => cueOverlay?.update(time),
    },
  });

  // The legacy player used the deprecated DOMNodeRemoved event to tear down
  // its cue overlay when the stage/carousel dropped it. A MutationObserver is
  // the supported equivalent and also unmounts the Svelte subtree.
  const observer = new MutationObserver(() => {
    if (target.isConnected) return;
    observer.disconnect();
    cueOverlay?.destroy();
    unmount(instance);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return target;
}
