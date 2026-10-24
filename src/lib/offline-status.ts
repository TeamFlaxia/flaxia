import { t } from './i18n.js';

let offline = typeof navigator !== 'undefined' && navigator.onLine === false;
export function setOffline(offlineNow: boolean): void {
  if (offline === offlineNow) return;
  offline = offlineNow;
  window.dispatchEvent(new CustomEvent('flaxiaConnectivityChange', { detail: { offline } }));
}
export function initOfflineStatus(): void {
  const banner = document.createElement('div');
  banner.className = 'offline-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  const text = document.createElement('span');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.addEventListener('click', () => window.dispatchEvent(new Event('flaxiaReconnect')));
  banner.appendChild(text);
  banner.appendChild(retry);
  const render = () => {
    banner.hidden = !offline;
    text.textContent = t('offline.browsing');
    retry.textContent = t('offline.retry');
  };
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('flaxiaConnectivityChange', render);
  window.addEventListener('localechange', render);
  document.body.insertBefore(banner, document.body.firstChild);
  render();
}
