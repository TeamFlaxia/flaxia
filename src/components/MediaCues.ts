// Legacy-compatible cue overlay bridge: cue rendering is owned by
// MediaCues.svelte. Callers only append `element` to a player and drive
// `update(seconds)`, so they keep working unchanged.
import { mount, unmount } from 'svelte';
import type { MediaCue } from '../../shared/post-cues.ts';
import MediaCuesView from '../lib/svelte/media/MediaCues.svelte';

export { parseMediaCues, stripMediaCues } from '../../shared/post-cues.ts';

export interface MediaCueOverlay {
  readonly element: HTMLElement;
  update(currentTimeSeconds: number): void;
  destroy(): void;
}

interface MediaCuesInstance {
  update: (currentTimeSeconds: number) => void;
}

/**
 * Niconico-style timed comments for a media element: danmaku that fly
 * right-to-left across the whole player height, and fixed top/bottom
 * subtitles. Driven entirely by the host media's clock; everything is
 * ephemeral and nothing is read from or written to a database.
 */
export function mountMediaCueOverlay(cues: MediaCue[] | undefined | null): MediaCueOverlay | null {
  if (!cues || cues.length === 0) return null;

  const target = document.createElement('div');
  const instance = mount(MediaCuesView, { target, props: { cues } }) as unknown as MediaCuesInstance;
  const element = target.firstElementChild;

  return {
    element: element instanceof HTMLElement ? element : target,
    update: (currentTimeSeconds) => instance.update(currentTimeSeconds),
    destroy() {
      const overlay = element instanceof HTMLElement ? element : null;
      unmount(instance as never);
      overlay?.remove();
    },
  };
}

/** Backwards-compatible factory name used by the legacy player adapters. */
export function createMediaCueOverlay(cues: MediaCue[] | undefined | null): MediaCueOverlay | null {
  return mountMediaCueOverlay(cues);
}
