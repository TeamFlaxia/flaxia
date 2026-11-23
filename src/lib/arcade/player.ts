// Game execution engine for the Arcade player. Everything that has to touch the
// sandboxed iframe lives here so the Svelte components stay declarative.
import type { Game } from '../../types/game.js';
import { ArcadeCaptureClient } from '../capture-client.js';
import { executeWvfsZip } from '../wvfs-zip-client.js';

export interface ArcadeCaptureApi {
  requestFrame: (timeoutMs?: number) => Promise<Blob>;
  composeScoreCard: (
    screenshot: Blob,
    meta: { title: string; username: string; score?: number; footer?: string },
  ) => Promise<Blob>;
}

export interface ArcadeViewportApi {
  capture: ArcadeCaptureApi | null;
  focus: () => void;
}

export interface ArcadePlayerHandle {
  capture: ArcadeCaptureApi | null;
  focus: () => void;
  destroy: () => void;
}

interface CaptureHooks {
  /** Called when the sandboxed game posts a score. */
  onPostScore?: (score: number, label: string) => void;
  onCaptureError?: (message: string) => void;
}

export function setupArcadeCapture(
  iframe: HTMLIFrameElement,
  sandboxOrigin: string,
  hooks: CaptureHooks = {},
): ArcadeCaptureClient | null {
  try {
    const client = new ArcadeCaptureClient({
      iframe,
      targetOrigin: sandboxOrigin,
      onError: hooks.onCaptureError,
      onPostScore: hooks.onPostScore,
    });
    // The frame is usually already loaded by the zip executor; send the
    // handshake now and keep the load listener as a slow-load fallback.
    client.init();
    iframe.addEventListener(
      'load',
      () => {
        client.init();
      },
      { once: true },
    );
    return client;
  } catch (error) {
    console.warn('Game capture unavailable:', error);
    return null;
  }
}

export async function mountZipPlayer(options: {
  game: Game;
  host: HTMLElement;
  sandboxOrigin: string;
  storageSnapshot?: Promise<Record<string, string>>;
  onPostScore?: (score: number, label: string) => void;
  onCaptureError?: (message: string) => void;
}): Promise<ArcadePlayerHandle> {
  const handle = await executeWvfsZip(
    options.game.postId,
    options.host,
    options.sandboxOrigin,
    true,
    false,
    undefined,
    options.storageSnapshot,
  );
  const iframe = options.host.querySelector('iframe');
  const client = iframe
    ? setupArcadeCapture(iframe, options.sandboxOrigin, {
        onPostScore: options.onPostScore,
        onCaptureError: options.onCaptureError,
      })
    : null;

  return {
    capture: client,
    focus: () => iframe?.focus(),
    destroy: () => {
      client?.destroy();
      handle.destroy();
    },
  };
}
