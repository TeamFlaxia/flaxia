import { t } from './i18n.js';

export interface WvfsZipExecutorHandle {
  destroy: () => void;
  postId: string;
}

const LOADING_TIMEOUT = 30000;

let activeHandle: WvfsZipExecutorHandle | null = null;

export async function executeWvfsZip(
  postId: string,
  containerEl: HTMLElement,
  workerUrl?: string,
  hideFullscreen: boolean = false,
  showLoading: boolean = true,
): Promise<WvfsZipExecutorHandle> {
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

    const sandboxOrigin = workerUrl || import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';
    const zipUrl = `${sandboxOrigin}/api/wvfs-zip/${postId}`;
    const preWarmUrl = `${zipUrl}/index.html`;
    fetch(preWarmUrl, { method: 'GET', mode: 'cors' }).catch(() => {});

    const { iframe, cleanup } = createWvfsIframe(postId, containerEl, zipUrl, hideFullscreen);

    const loaded = await waitForLoad(iframe, loadingEl);

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

    const handle: WvfsZipExecutorHandle = {
      postId,
      destroy: () => {
        clearTimeout((iframe as HTMLIFrameElement & { _wvfsTimeout?: number })._wvfsTimeout);
        cleanup();
        const fullscreenBtn = containerEl.querySelector('.wvfs-fullscreen-btn');
        if (fullscreenBtn) {
          fullscreenBtn.parentNode?.removeChild(fullscreenBtn);
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
    throw error;
  }
}

function createLoadingIndicator(): HTMLElement {
  ensureSpinKeyframe();

  const loading = document.createElement('div');
  loading.className = 'wvfs-loading';
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
    animation: wvfs-spin 0.8s linear infinite;
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

function createWvfsIframe(
  postId: string,
  containerEl: HTMLElement,
  zipUrl: string,
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
  iframe.src = zipUrl;
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
  fullscreenBtn.className = 'wvfs-fullscreen-btn';
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
        document.exitFullscreen().catch((err) => {
          console.warn('Exit fullscreen failed:', err);
        });
      } else if (iframeContainer.requestFullscreen) {
        iframeContainer.requestFullscreen().catch((err) => {
          console.warn('Container fullscreen failed:', err);
          if (iframe.requestFullscreen) {
            iframe.requestFullscreen().catch((err2) => {
              console.warn('Iframe fullscreen failed:', err2);
            });
          }
        });
      } else if (iframe.requestFullscreen) {
        iframe.requestFullscreen().catch((err) => {
          console.warn('Iframe fullscreen failed:', err);
        });
      }
    } catch (error) {
      console.error('Fullscreen error:', error);
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

function waitForLoad(iframe: HTMLIFrameElement, loadingEl: HTMLElement | null): Promise<boolean> {
  return new Promise((resolve) => {
    if (iframe.contentWindow?.location?.href && iframe.contentWindow.location.href !== 'about:blank') {
      iframe.style.opacity = '1';
      resolve(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      iframe.removeEventListener('load', onLoad);
      resolve(false);
    }, LOADING_TIMEOUT);

    (iframe as HTMLIFrameElement & { _wvfsTimeout?: number })._wvfsTimeout = timeoutId;

    function onLoad() {
      clearTimeout(timeoutId);
      resolve(true);
    }

    iframe.addEventListener('load', onLoad, { once: true });
  });
}

function ensureSpinKeyframe(): void {
  if (!document.querySelector('#wvfs-spin-style')) {
    const style = document.createElement('style');
    style.id = 'wvfs-spin-style';
    style.textContent = `@keyframes wvfs-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}
