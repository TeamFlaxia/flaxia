import { executeWvfsZip } from './wvfs-zip-client.js';
import { ZIP_FETCH_TIMEOUT, ZIP_READY_TIMEOUT, ZIP_SW_CONTROLLER_TIMEOUT } from './zip-constants.js';
import {
  createZipLoadingIndicator,
  createZipSandboxIframe,
  fadeOutLoading,
  showLoadingTimeoutMessage,
  waitForZipIframeLoad,
} from './zip-ui-utils.js';

export interface SwZipExecutorHandle {
  destroy: () => void;
  postId: string;
}

const SW_SCOPE = '/sw-zip/';
const SW_URL = '/sw-zip/sw.js';
const PREFIX = 'sw-zip';

let activeHandle: SwZipExecutorHandle | null = null;

let swRegistrationPromise: Promise<ServiceWorkerRegistration> | null = null;

function getOrCreateSwReg(): Promise<ServiceWorkerRegistration> {
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  }
  return swRegistrationPromise;
}

function waitForController(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (navigator.serviceWorker.controller) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error('Service Worker controller timeout'));
    }, ZIP_SW_CONTROLLER_TIMEOUT);

    const handler = () => {
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('controllerchange', handler);
      resolve();
    };

    navigator.serviceWorker.addEventListener('controllerchange', handler);

    const interval = setInterval(() => {
      if (navigator.serviceWorker.controller) {
        clearTimeout(timeout);
        clearInterval(interval);
        navigator.serviceWorker.removeEventListener('controllerchange', handler);
        resolve();
      }
    }, 100);
  });
}

function waitForZipReady(postId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('ZIP readiness timeout'));
    }, ZIP_READY_TIMEOUT);

    const watchdog = setTimeout(() => {
      reject(new Error('ZIP extraction watchdog timeout'));
    }, 5000);

    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'ZIP_READY' && event.data.postId === postId) {
        clearTimeout(timeout);
        clearTimeout(watchdog);
        navigator.serviceWorker.removeEventListener('message', handler);
        resolve();
      }
      if (event.data?.type === 'ZIP_ERROR' && event.data.postId === postId) {
        clearTimeout(timeout);
        clearTimeout(watchdog);
        navigator.serviceWorker.removeEventListener('message', handler);
        reject(new Error(event.data.error || 'ZIP extraction failed'));
      }
    };

    navigator.serviceWorker.addEventListener('message', handler);
  });
}

async function fetchZip(postId: string, fallbackUrl?: string, versionId?: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZIP_FETCH_TIMEOUT);

  try {
    const zipUrl = fallbackUrl || `/api/zip/${postId}${versionId ? `?v=${versionId}` : ''}`;
    const res = await fetch(zipUrl, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`ZIP fetch failed: ${res.status}`);
    }

    const zipData = await res.arrayBuffer();
    return zipData;
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeSwZip(
  postId: string,
  containerEl: HTMLElement,
  fallbackUrl?: string,
  hideFullscreen: boolean = false,
  showLoading: boolean = true,
  versionId?: string,
): Promise<SwZipExecutorHandle> {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    containerEl.innerHTML = '';
    containerEl.style.position = 'relative';

    let loadingEl: HTMLElement | null = null;
    if (showLoading) {
      loadingEl = createZipLoadingIndicator(PREFIX);
      containerEl.appendChild(loadingEl);
    }

    await getOrCreateSwReg();
    await navigator.serviceWorker.ready;
    await waitForController();

    const zipData = await fetchZip(postId, fallbackUrl, versionId);

    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      throw new Error('No Service Worker controller available');
    }

    controller.postMessage({ type: 'SETUP_ZIP', postId, zipData });

    await waitForZipReady(postId);

    const { iframe, cleanup } = createZipSandboxIframe(containerEl, `/sw-zip/${postId}/index.html`, {
      hideFullscreen,
      prefix: PREFIX,
    });

    const loaded = await waitForZipIframeLoad(iframe, loadingEl);

    if (loaded) {
      iframe.style.opacity = '1';
      fadeOutLoading(loadingEl);
    } else {
      showLoadingTimeoutMessage(loadingEl);
      iframe.style.opacity = '1';
    }

    const handle: SwZipExecutorHandle = {
      postId,
      destroy: () => {
        clearTimeout((iframe as HTMLIFrameElement & { _zipLoadTimeout?: number })._zipLoadTimeout);
        cleanup();
        try {
          navigator.serviceWorker.controller?.postMessage({ type: 'CLEANUP_ZIP', postId });
        } catch {
          // SW might be gone
        }
        if (activeHandle?.postId === postId) {
          activeHandle = null;
        }
      },
    };

    activeHandle = handle;
    return handle;
  } catch (error) {
    if (activeHandle) {
      activeHandle.destroy();
      activeHandle = null;
    }

    console.warn('SW ZIP execution failed, falling back to WVFS:', error);

    const wvfsHandle = await executeWvfsZip(postId, containerEl, fallbackUrl, hideFullscreen, showLoading);
    const handle: SwZipExecutorHandle = {
      postId,
      destroy: () => wvfsHandle.destroy(),
    };
    activeHandle = handle;
    return handle;
  }
}
