let offline = typeof navigator !== 'undefined' && navigator.onLine === false;

/** Broadcast connectivity changes without pinning any UI to the viewport. */
export function setOffline(offlineNow: boolean): void {
  if (offline === offlineNow) return;
  offline = offlineNow;
  window.dispatchEvent(new CustomEvent('flaxiaConnectivityChange', { detail: { offline } }));
}
