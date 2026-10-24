import { t } from '../lib/i18n.ts';
import { offlineGames } from '../lib/native-offline-games.ts';

export function createOfflineDownloads() {
  const element = document.createElement('section');
  element.style.cssText = 'padding:16px;border-bottom:1px solid var(--border);';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const hint = document.createElement('p');
  hint.textContent = t('offline_games.hint');
  const retry = document.createElement('button');
  retry.textContent = t('offline_games.retry');
  retry.addEventListener('click', () => void offlineGames?.sync());
  element.appendChild(status);
  element.appendChild(hint);
  element.appendChild(retry);
  let destroyed = false;
  const render = async () => {
    try {
      const saved = (await offlineGames?.list()) ?? [];
      if (destroyed) return;
      const states = [...(offlineGames?.states.values() ?? [])];
      status.textContent = t('offline_games.status', {
        saved: saved.length,
        downloading: states.filter((state) => state === 'downloading').length,
        errors: states.filter((state) => state === 'error').length,
      });
      retry.disabled = navigator.onLine === false || states.includes('downloading');
    } catch {
      status.textContent = t('offline_games.storage_error');
    }
  };
  window.addEventListener('flaxiaDownloadsChanged', render);
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  void render();
  return {
    element,
    destroy: () => {
      destroyed = true;
      window.removeEventListener('flaxiaDownloadsChanged', render);
      window.removeEventListener('online', render);
      window.removeEventListener('offline', render);
    },
  };
}
