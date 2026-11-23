// Legacy-compatible bridge: the Flash player UI is owned by
// FlashPlayer.svelte. This module keeps the SWF fetch, single-active-player
// rule and the public executeFlash() contract used by PostStage and AdCard.
import { type Component, mount, unmount } from 'svelte';
import FlashPlayerView from '../lib/svelte/media/FlashPlayer.svelte';

export interface FlashPlayerHandle {
  destroy: () => void;
}

let activeHandle: FlashPlayerHandle | null = null;

export async function executeFlash(
  postId: string,
  containerEl: HTMLElement,
  url?: string,
  hideFullscreen: boolean = false,
  preloadedData?: ArrayBuffer,
): Promise<FlashPlayerHandle> {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  containerEl.replaceChildren();
  containerEl.style.position = 'relative';

  const swfUrl = url || `/api/swf/${postId}`;
  const swfPromise = preloadedData
    ? Promise.resolve(preloadedData)
    : fetch(swfUrl).then((r) => {
        if (!r.ok) throw new Error('Failed to fetch SWF');
        return r.arrayBuffer();
      });

  let resolveSettled!: () => void;
  let rejectSettled!: (error: Error) => void;
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });

  const instance = mount(FlashPlayerView as Component, {
    target: containerEl,
    props: {
      swf: swfPromise,
      hideFullscreen,
      onSettled: (error?: Error) => {
        if (error) rejectSettled(error);
        else resolveSettled();
      },
    },
  });

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    unmount(instance);
    containerEl.replaceChildren();
    if (activeHandle === handle) activeHandle = null;
  };
  const handle: FlashPlayerHandle = { destroy };

  try {
    await settled;
  } catch (error) {
    if (activeHandle === handle) activeHandle = null;
    // Callers own their failure UI; unmount before rethrowing so no timer or
    // pending SWF fetch keeps the component alive.
    destroy();
    throw error;
  }

  activeHandle = handle;
  return handle;
}

export function isValidSwfFile(file: File): boolean {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext !== 'swf') return false;

  const validTypes = ['application/x-shockwave-flash', 'application/vnd.adobe.flash.movie'];
  if (file.type && !validTypes.includes(file.type)) {
    if (file.type !== '' && file.type !== 'application/octet-stream') return false;
  }

  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) return false;

  return true;
}

export async function validateSwfFile(file: File): Promise<boolean> {
  const header = await file.slice(0, 3).arrayBuffer();
  const headerStr = new TextDecoder().decode(header);
  return headerStr === 'FWS' || headerStr === 'CWS' || headerStr === 'ZWS';
}
