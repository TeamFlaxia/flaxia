/** Global side effects that used to live at the top of legacy main.ts. */

import { showCrowdConsentModal } from '../../components/CrowdConsentModal.ts';
import { initContentProtection } from '../content-protection.js';
import { canRunFlaxiaNode, initCrowdNode, notifyCrowdConsentChanged } from '../crowd-node.js';
import { API_ORIGIN, isNativeApp } from '../native-api.js';
import { createNativeFetch } from '../native-fetch.js';
import { initOfflineGames } from '../native-offline-games.js';
import { createOfflineFetch } from '../offline-fetch.js';
import { setOffline } from '../offline-status.js';
import { createOfflineStore } from '../offline-store.js';
import { initPerformanceMonitoring } from '../performance.js';
import { startRenderDiagnostics } from '../render-diagnostics.js';
import { initTheme } from '../theme.js';

let started = false;

/**
 * Run `start` once the browser is idle, with a three-second ceiling. The
 * `@flaxia/node` bundle probes gigabytes of WebAssembly.Memory synchronously,
 * so calling it during boot would freeze clicks until the probe finishes.
 * Whichever scheduler fires first wins; the other one is cancelled.
 */
function deferCrowdNodeInit(start: () => void): void {
  let settled = false;
  let idleHandle: number | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const settle = (shouldStart: boolean): void => {
    if (settled) return;
    settled = true;
    if (idleHandle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandle);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (shouldStart) start();
  };

  // `requestIdleCallback` can be starved by a busy tab (and is missing in some
  // webviews), so a plain timer acts as both fallback and hard deadline.
  timeoutHandle = setTimeout(() => settle(true), 3000);
  if (typeof requestIdleCallback === 'function') {
    idleHandle = requestIdleCallback(() => settle(true), { timeout: 3000 });
  }
}

/** Start the node after boot, preserving the host-managed consent prompts. */
function startCrowdNode(): void {
  void initCrowdNode((controls) => {
    showCrowdConsentModal({
      onAccept: () => {
        controls.accept();
        notifyCrowdConsentChanged();
      },
      onReject: () => {
        controls.reject();
        notifyCrowdConsentChanged();
      },
    });
  }).catch((error) => {
    // A missing/unreachable node bundle must never break app init.
    console.error('Failed to initialize Crowd node:', error);
  });
}

export function initShellBootstrap(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  initPerformanceMonitoring();
  startRenderDiagnostics();

  const nativeClient = isNativeApp();
  const nativeFetch = createNativeFetch(window.fetch.bind(window));
  // No connectivity probe here: the old one hit `/api/me` with `no-store`,
  // triggering a second full auth chain on native boot. navigator.onLine and
  // the first real API response still drive the offline banner/recovery.
  window.fetch = nativeClient
    ? createOfflineFetch(nativeFetch, {
        store: createOfflineStore(),
        baseUrl: window.location.href,
        apiOrigin: API_ORIGIN,
        isOnline: () => navigator.onLine !== false,
        setOffline,
      })
    : nativeFetch;
  if (nativeClient) window.fetch = initOfflineGames(nativeFetch).wrap(window.fetch);

  initContentProtection();
  initTheme();

  // The legacy main.ts initialised the Crowd node globally. Keep that behavior
  // (so a fresh visit still shows the consent prompt) but start it off the boot
  // path: its WASM memory probe is synchronous and blocks every click.
  if (canRunFlaxiaNode()) {
    deferCrowdNodeInit(startCrowdNode);
  }
}
