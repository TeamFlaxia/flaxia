let offline = typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Expose the state for styling and native smoke tests without pinning a banner
 * to the viewport.
 */
function publishOfflineState(): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.offline = offline ? 'true' : 'false';
  }
}

publishOfflineState();

/** Broadcast connectivity changes without pinning any UI to the viewport. */
export function setOffline(offlineNow: boolean): void {
  if (offline === offlineNow) return;
  offline = offlineNow;
  publishOfflineState();
  window.dispatchEvent(new CustomEvent('flaxiaConnectivityChange', { detail: { offline } }));
}

/**
 * Whether the client currently has authoritative evidence that it is offline.
 * The native offline layer corrects a stale `navigator.onLine` value, so callers
 * should prefer this over reading `navigator.onLine` directly.
 */
export function isOffline(): boolean {
  return offline;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('DOMContentLoaded', publishOfflineState);
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => setOffline(false));
}
