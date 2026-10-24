import { t } from './i18n.ts';
import { offlineGames } from './native-offline-games.ts';
import { OFFLINE_GAME_SHELL } from './offline-game-shell.generated.ts';

export async function executeDownloadedGame(postId: string, container: HTMLElement, versionId?: string) {
  const files = await offlineGames?.files(postId, versionId);
  if (!files) return undefined;
  const iframe = document.createElement('iframe');
  iframe.title = t('offline_games.player');
  iframe.sandbox = 'allow-scripts allow-pointer-lock';
  iframe.allow = 'fullscreen; autoplay';
  iframe.referrerPolicy = 'no-referrer';
  iframe.style.cssText = 'width:100%;height:100%;border:0;';
  const channel = new MessageChannel();
  const storageKey = offlineGames?.storageKey(postId);
  let snapshot = {};
  try {
    if (storageKey) snapshot = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
  } catch {
    /* empty save */
  }
  let timeout: ReturnType<typeof setTimeout>;
  let rejectPending: (reason: Error) => void;
  const cleanup = () => {
    clearTimeout(timeout);
    window.removeEventListener('message', ready);
    window.removeEventListener('flaxiaDownloadsChanged', accountChanged);
    channel.port1.close();
    channel.port2.close();
    iframe.remove();
  };
  const ready = (event: MessageEvent) => {
    if (
      event.source !== iframe.contentWindow ||
      event.origin !== 'null' ||
      event.data?.type !== 'FLAXIA_LOCAL_GAME_READY'
    )
      return;
    window.removeEventListener('message', ready);
    iframe.contentWindow?.postMessage({ type: 'FLAXIA_LOCAL_GAME', files, snapshot }, '*', [channel.port2]);
  };
  const accountChanged = () => {
    if (offlineGames?.storageKey(postId) !== storageKey) cleanup();
  };
  const loaded = new Promise<void>((resolve, reject) => {
    rejectPending = reject;
    timeout = setTimeout(() => reject(new Error(t('offline_games.unsupported'))), 15_000);
    channel.port1.onmessage = (event: MessageEvent<{ ok?: boolean; save?: Record<string, unknown> }>) => {
      if (event.data.save && storageKey && offlineGames?.storageKey(postId) === storageKey) {
        const save = event.data.save;
        if (typeof save !== 'object' || Array.isArray(save)) return;
        const text = JSON.stringify(save);
        if (text.length > 65536 || Object.values(save).some((value) => typeof value !== 'string')) return;
        try {
          localStorage.setItem(storageKey, text);
        } catch {
          /* storage quota */
        }
        return;
      }
      if (event.data.ok) resolve();
      else reject(new Error(t('offline_games.unsupported')));
    };
  });
  window.addEventListener('message', ready);
  window.addEventListener('flaxiaDownloadsChanged', accountChanged);
  // Only the bundled bootstrap is HTML. Game bytes never enter the app document.
  iframe.srcdoc =
    '<!doctype html><html><head><meta charset="utf-8"></head><body><script>' +
    OFFLINE_GAME_SHELL.replace(/<\/script/gi, '<\\/script') +
    '</script></body></html>';
  container.replaceChildren(iframe);
  try {
    await loaded;
    clearTimeout(timeout!);
    return {
      postId,
      destroy: () => {
        cleanup();
        rejectPending(new Error('Player closed'));
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
