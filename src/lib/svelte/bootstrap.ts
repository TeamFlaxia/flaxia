/** Global side effects that used to live at the top of legacy main.ts. */
import { initContentProtection } from '../content-protection.js';
import { API_ORIGIN, isNativeApp } from '../native-api.js';
import { createNativeFetch } from '../native-fetch.js';
import { initOfflineGames } from '../native-offline-games.js';
import { createOfflineFetch } from '../offline-fetch.js';
import { setOffline } from '../offline-status.js';
import { createOfflineStore } from '../offline-store.js';
import { initPerformanceMonitoring } from '../performance.js';
import { startRenderDiagnostics } from '../render-diagnostics.js';
import { initTheme } from '../theme.js';
import { initSpaNavigateBridge } from './spa-navigate-bridge.ts';

let started = false;

export function initShellBootstrap(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  initPerformanceMonitoring();
  startRenderDiagnostics();
  initSpaNavigateBridge();

  const nativeClient = isNativeApp();
  const nativeFetch = createNativeFetch(window.fetch.bind(window));
  const probeConnectivity = async (): Promise<boolean> => {
    try {
      const response = await nativeFetch('/api/me', {
        cache: 'no-store',
        credentials: 'include',
        signal: AbortSignal.timeout(15000),
      });
      try {
        await response.body?.cancel();
      } catch {
        // The response already proved connectivity.
      }
      return true;
    } catch {
      return false;
    }
  };
  window.fetch = nativeClient
    ? createOfflineFetch(nativeFetch, {
        store: createOfflineStore(),
        baseUrl: window.location.href,
        apiOrigin: API_ORIGIN,
        isOnline: () => navigator.onLine !== false,
        setOffline,
        probe: probeConnectivity,
      })
    : nativeFetch;
  if (nativeClient) window.fetch = initOfflineGames(nativeFetch).wrap(window.fetch);

  initContentProtection();
  initTheme();
}
