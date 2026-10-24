import type { GameFile } from './offline-game-store.ts';
import { createOfflineGameStore } from './offline-game-store.ts';
import { createOfflineGames } from './offline-games.ts';

export function extractGameArchive(bytes: ArrayBuffer): Promise<GameFile[]> {
  const worker = new Worker(new URL('./game-loader-unzip-worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Game extraction timed out')), 30_000);
    function finish(error?: Error, files?: GameFile[]) {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error);
      else resolve(files!);
    }
    worker.onerror = () => finish(new Error('Game extraction failed'));
    worker.onmessage = (event: MessageEvent<{ ok: boolean; error?: string; files?: GameFile[] }>) => {
      if (event.data.ok && event.data.files) finish(undefined, event.data.files);
      else finish(new Error(event.data.error ?? 'Game extraction failed'));
    };
    worker.postMessage(bytes, [bytes]);
  });
}

export let offlineGames: ReturnType<typeof createOfflineGames> | undefined;
export function initOfflineGames(network: typeof fetch): NonNullable<typeof offlineGames> {
  offlineGames ??= createOfflineGames({
    store: createOfflineGameStore(),
    network,
    extract: extractGameArchive,
    baseUrl: window.location.href,
    online: () => navigator.onLine !== false,
    changed: () => window.dispatchEvent(new Event('flaxiaDownloadsChanged')),
  });
  window.addEventListener('online', () => void offlineGames?.sync());
  return offlineGames;
}
