import { t } from './i18n.js';
import { executeWvfsZip } from './wvfs-zip-client.js';

export interface SwZipExecutorHandle {
  destroy: () => void;
  postId: string;
}

const SW_SCOPE = '/sw-zip/';
const SW_URL = '/sw-zip/sw.js';
const FS_READY_TIMEOUT = 10000;
const ZIP_FETCH_TIMEOUT = 15000;
const LOADING_TIMEOUT = 30000;

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
    }, 10000);

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
    }, FS_READY_TIMEOUT);

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

async function fetchZip(postId: string, fallbackUrl?: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZIP_FETCH_TIMEOUT);

  try {
    const zipUrl = fallbackUrl || `/api/zip/${postId}`;
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

function createLoadingIndicator(): HTMLElement {
  ensureSpinKeyframe();

  const loading = document.createElement('div');
  loading.className = 'sw-zip-loading';
  loading.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--bg-primary, #ffffff);
    z-index: 10;
    transition: opacity 0.3s ease;
    border-radius: 8px;
  `;

  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 32px;
    height: 32px;
    border: 3px solid var(--border, #e2e8f0);
    border-top-color: var(--accent, #22c55e);
    border-radius: 50%;
    animation: sw-zip-spin 0.8s linear infinite;
    margin-bottom: 12px;
  `;

  const text = document.createElement('div');
  text.style.cssText = `
    color: var(--text-muted, #64748b);
    font-size: 0.875rem;
    font-weight: 500;
  `;
  text.textContent = t('post_stage.loading_zip').replace(/<[^>]+>/g, '');

  loading.appendChild(spinner);
  loading.appendChild(text);
  return loading;
}

function ensureSpinKeyframe(): void {
  if (!document.querySelector('#sw-zip-spin-style')) {
    const style = document.createElement('style');
    style.id = 'sw-zip-spin-style';
    style.textContent = `@keyframes sw-zip-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}

function createSandboxIframe(
  postId: string,
  containerEl: HTMLElement,
  hideFullscreen: boolean,
): { iframe: HTMLIFrameElement; cleanup: () => void } {
  const iframeContainer = document.createElement('div');
  iframeContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
  `;

  const iframe = document.createElement('iframe');
  iframe.src = `/sw-zip/${postId}/index.html`;
  iframe.sandbox = 'allow-scripts allow-pointer-lock allow-fullscreen';
  iframe.setAttribute('allow', 'fullscreen');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    opacity: 0;
    transition: opacity 0.3s ease;
  `;

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.textContent = t('fullscreen.button');
  fullscreenBtn.className = 'sw-zip-fullscreen-btn';
  fullscreenBtn.style.cssText = `
    margin-top: 8px;
    padding: 4px 8px;
    font-size: 12px;
    border: 1px solid #ccc;
    background: #f0f0f0;
    cursor: pointer;
    border-radius: 4px;
    align-self: center;
  `;
  fullscreenBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (iframeContainer.requestFullscreen) {
        iframeContainer.requestFullscreen().catch(() => {
          if (iframe.requestFullscreen) {
            iframe.requestFullscreen().catch(() => {});
          }
        });
      } else if (iframe.requestFullscreen) {
        iframe.requestFullscreen().catch(() => {});
      }
    } catch {
      // ignore
    }
  };

  containerEl.appendChild(iframeContainer);
  iframeContainer.appendChild(iframe);
  if (!hideFullscreen) {
    iframeContainer.appendChild(fullscreenBtn);
  }

  const cleanup = () => {
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  };

  return { iframe, cleanup };
}

function waitForIframeLoad(iframe: HTMLIFrameElement, loadingEl: HTMLElement | null): Promise<boolean> {
  return new Promise((resolve) => {
    if (iframe.contentWindow?.location?.href && iframe.contentWindow.location.href !== 'about:blank') {
      resolve(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      iframe.removeEventListener('load', onLoad);
      resolve(false);
    }, LOADING_TIMEOUT);

    (iframe as HTMLIFrameElement & { _swZipTimeout?: number })._swZipTimeout = timeoutId;

    function onLoad() {
      clearTimeout(timeoutId);
      resolve(true);
    }

    iframe.addEventListener('load', onLoad, { once: true });
  });
}

export async function executeSwZip(
  postId: string,
  containerEl: HTMLElement,
  fallbackUrl?: string,
  hideFullscreen: boolean = false,
  showLoading: boolean = true,
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
      loadingEl = createLoadingIndicator();
      containerEl.appendChild(loadingEl);
    }

    await getOrCreateSwReg();
    await navigator.serviceWorker.ready;
    await waitForController();

    const zipData = await fetchZip(postId, fallbackUrl);

    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      throw new Error('No Service Worker controller available');
    }

    controller.postMessage({ type: 'SETUP_ZIP', postId, zipData });

    await waitForZipReady(postId);

    const { iframe, cleanup } = createSandboxIframe(postId, containerEl, hideFullscreen);

    const loaded = await waitForIframeLoad(iframe, loadingEl);

    if (loaded) {
      iframe.style.opacity = '1';
      if (loadingEl?.parentNode) {
        loadingEl.style.opacity = '0';
        setTimeout(() => {
          if (loadingEl?.parentNode) loadingEl.remove();
        }, 300);
      }
    } else {
      if (loadingEl?.parentNode) {
        loadingEl.innerHTML = `<div style="color: var(--text-muted, #64748b); text-align: center; padding: 20px; font-size: 0.875rem;">読み込みに時間がかかっています…</div>`;
      }
      iframe.style.opacity = '1';
    }

    const handle: SwZipExecutorHandle = {
      postId,
      destroy: () => {
        clearTimeout((iframe as HTMLIFrameElement & { _swZipTimeout?: number })._swZipTimeout);
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
