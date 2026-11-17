/**
 * Silence media inside a subtree without rebuilding or destroying it.
 *
 * Parking a view (`#app-parking`) and collapsing a post stage both hide a
 * surface that may still be playing audio. `display: none` does not destroy an
 * iframe's browsing context and does not pause a detached `<video>`/`<audio>`,
 * so a game or player would keep making noise off screen. This module toggles
 * the mute state instead:
 *
 * - `<audio>` / `<video>`: set `muted`, remembering the previous value so a
 *   user-muted player stays muted after the view is restored.
 * - `<ruffle-player>`: adjusts `volume` (the Flash player lives in a trusted
 *   sandbox document, but the element is normally not in the app's DOM).
 * - Game iframes: posts the typed `GAME_AUDIO_MUTE_MESSAGE` to the frame; the
 *   runtime injected by the sandbox worker (and the local ZIP preview shell)
 *   applies it inside the opaque game document.
 */
import { GAME_AUDIO_MUTE_MESSAGE } from '../../sandbox/zip-preview-protocol.js';

const previousMuted = new WeakMap<HTMLMediaElement, boolean>();
const previousVolume = new WeakMap<Element, number>();

interface RuffleLike extends HTMLElement {
  volume?: number;
  muted?: boolean;
}

/** Mute or restore every media surface below `root`. */
export function setMediaMuted(root: HTMLElement, muted: boolean): void {
  if (typeof document === 'undefined') return;

  for (const element of root.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (muted) {
      if (!previousMuted.has(element)) previousMuted.set(element, element.muted);
      element.muted = true;
      continue;
    }

    const wasMuted = previousMuted.get(element);
    if (wasMuted === undefined) continue;
    element.muted = wasMuted;
    previousMuted.delete(element);
  }

  for (const element of root.querySelectorAll<Element>('ruffle-player')) {
    const player = element as RuffleLike;
    if (typeof player.volume === 'number') {
      if (muted) {
        if (!previousVolume.has(player)) previousVolume.set(player, player.volume);
        player.volume = 0;
      } else {
        const volume = previousVolume.get(player);
        player.volume = volume ?? 1;
        previousVolume.delete(player);
      }
      continue;
    }

    if (muted) player.muted = true;
    else player.muted = false;
  }

  for (const iframe of root.querySelectorAll<HTMLIFrameElement>('iframe')) {
    iframe.dataset.flxMuted = muted ? '1' : '0';

    // A frame that is still loading cannot receive the message yet. Re-send the
    // last requested state when it finishes navigating.
    if (iframe.dataset.flxMuteHooked !== '1') {
      iframe.dataset.flxMuteHooked = '1';
      iframe.addEventListener('load', () => {
        if (iframe.dataset.flxMuted !== '1') return;
        try {
          iframe.contentWindow?.postMessage({ type: GAME_AUDIO_MUTE_MESSAGE, muted: true }, '*');
        } catch {
          // Frame navigated away.
        }
      });
    }

    try {
      iframe.contentWindow?.postMessage({ type: GAME_AUDIO_MUTE_MESSAGE, muted }, '*');
    } catch {
      // A detached or already-navigated frame cannot receive the message.
    }
  }
}

/**
 * Stop playback entirely. Used when a parked view is discarded: a detached
 * media element can keep playing in some browsers even after it leaves the
 * document.
 */
export function pauseMediaIn(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLMediaElement>('audio, video')) {
    try {
      element.pause();
    } catch {
      // Some embedded players throw when paused before metadata is ready.
    }
  }
}
