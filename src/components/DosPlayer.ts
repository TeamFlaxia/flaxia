import { t } from '../lib/i18n.js';

export interface DosPlayerHandle {
  destroy: () => void;
}

const LOADING_TIMEOUT = 30000;

let activeHandle: DosPlayerHandle | null = null;

function isTauri(): boolean {
  try {
    return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
  } catch {
    return false;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'lvh.me';
  } catch {
    return false;
  }
}

const FLAXIA_ORIGIN = 'https://flaxia.app';

export async function executeDos(
  postId: string,
  containerEl: HTMLElement,
  url?: string,
  hideFullscreen: boolean = false,
): Promise<DosPlayerHandle> {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    containerEl.innerHTML = '';
    containerEl.style.position = 'relative';

    const loadingEl = createDosLoadingIndicator();
    containerEl.appendChild(loadingEl);

    const currentOrigin = window.location.origin;
    const isLocalDev = isLocalOrigin(currentOrigin);
    const apiOrigin = import.meta.env.VITE_CONTENT_ORIGIN || (isTauri() && !isLocalDev ? FLAXIA_ORIGIN : currentOrigin);
    const zipUrl = url || `${apiOrigin}/api/zip/${postId}`;
    const dosPlayerUrl = `${apiOrigin}/api/dos-player/${postId}?zip_url=${encodeURIComponent(zipUrl)}&load_failed=${encodeURIComponent(t('dos_player.load_failed'))}`;

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
    iframe.sandbox = 'allow-scripts allow-pointer-lock allow-fullscreen';
    iframe.src = dosPlayerUrl;
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
    fullscreenBtn.textContent = t('dos_player.fullscreen');
    fullscreenBtn.className = 'dos-fullscreen-btn';
    fullscreenBtn.style.cssText = `
      margin-top: 0;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid #555;
      background: #222;
      color: #fff;
      cursor: pointer;
      border-radius: 4px;
      align-self: center;
    `;
    fullscreenBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        if (iframeContainer.requestFullscreen) {
          iframeContainer.requestFullscreen().catch((err: Error) => {
            console.warn('Container fullscreen failed:', err);
            if (iframe.requestFullscreen) {
              iframe.requestFullscreen().catch((err2: Error) => {
                console.warn('Iframe fullscreen failed:', err2);
              });
            }
          });
        } else if (iframe.requestFullscreen) {
          iframe.requestFullscreen().catch((err: Error) => {
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

    const loaded = await waitForDosLoad(iframe, loadingEl);

    if (loaded) {
      iframe.style.opacity = '1';
      if (loadingEl.parentNode) {
        loadingEl.style.opacity = '0';
        setTimeout(() => {
          if (loadingEl.parentNode) loadingEl.remove();
        }, 300);
      }
    } else {
      if (loadingEl.parentNode) {
        loadingEl.innerHTML = `<div style="color: var(--text-muted, #64748b); text-align: center; padding: 20px; font-size: 0.875rem;">読み込みに時間がかかっています…</div>`;
      }
      iframe.style.opacity = '1';
    }

    const handle: DosPlayerHandle = {
      destroy: () => {
        clearTimeout((iframe as HTMLIFrameElement & { _dosTimeout?: number })._dosTimeout);
        if (iframeContainer.parentNode) {
          iframeContainer.parentNode.removeChild(iframeContainer);
        }
        const btn = containerEl.querySelector('.dos-fullscreen-btn');
        if (btn) btn.parentNode?.removeChild(btn);
      },
    };

    activeHandle = handle;
    return handle;
  } catch (error) {
    if (activeHandle) {
      activeHandle.destroy();
      activeHandle = null;
    }

    containerEl.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: 20px;
        text-align: center;
        color: var(--text-muted, #64748b);
      ">
        <div style="font-size: 48px; margin-bottom: 16px;">💾</div>
        <div style="font-weight: bold; margin-bottom: 8px;">${t('dos_player.error_heading')}</div>
        <div style="font-size: 14px;">${error instanceof Error ? error.message : t('common.error')}</div>
      </div>
    `;

    throw error;
  }
}

function createDosLoadingIndicator(): HTMLElement {
  ensureSpinKeyframe();

  const loading = document.createElement('div');
  loading.className = 'dos-loading';
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
  text.textContent = t('post_stage.loading_dos').replace(/<[^>]+>/g, '');

  loading.appendChild(spinner);
  loading.appendChild(text);
  return loading;
}

function waitForDosLoad(iframe: HTMLIFrameElement, loadingEl: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      iframe.removeEventListener('load', onLoad);
      resolve(false);
    }, LOADING_TIMEOUT);

    (iframe as HTMLIFrameElement & { _dosTimeout?: number })._dosTimeout = timeoutId;

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
