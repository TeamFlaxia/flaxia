import { buildFlashPlayerDocument } from '../lib/flash-player-document.js';
import { t } from '../lib/i18n.js';

export interface FlashPlayerHandle {
  destroy: () => void;
}

const LOADING_TIMEOUT = 30000;

let activeHandle: FlashPlayerHandle | null = null;

export async function executeFlash(
  postId: string,
  containerEl: HTMLElement,
  url?: string,
  hideFullscreen: boolean = false,
  preloadedData?: ArrayBuffer,
): Promise<FlashPlayerHandle> {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    containerEl.innerHTML = '';
    containerEl.style.position = 'relative';

    const loadingEl = createFlashLoadingIndicator();
    containerEl.appendChild(loadingEl);

    const swfUrl = url || `/api/swf/${postId}`;

    const swfPromise = preloadedData
      ? Promise.resolve(preloadedData)
      : fetch(swfUrl).then((r) => {
          if (!r.ok) throw new Error('Failed to fetch SWF');
          return r.arrayBuffer();
        });

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

    const htmlContent = buildFlashPlayerDocument(t('flash_player.title'), t('flash_player.load_failed'));

    const htmlBlob = new Blob([htmlContent], { type: 'text/html' });
    const htmlBlobUrl = URL.createObjectURL(htmlBlob);

    const iframe = document.createElement('iframe');
    iframe.src = htmlBlobUrl;
    iframe.sandbox = 'allow-scripts allow-pointer-lock allow-forms allow-popups';
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
    fullscreenBtn.textContent = t('flash_player.fullscreen');
    fullscreenBtn.className = 'flash-fullscreen-btn';
    fullscreenBtn.style.cssText = `
      margin-top: 0;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid var(--border);
      background: var(--bg-tertiary);
      cursor: pointer;
      border-radius: 4px;
      align-self: center;
    `;
    fullscreenBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch((err: Error) => {
            console.warn('Exit fullscreen failed:', err);
          });
        } else if (iframeContainer.requestFullscreen) {
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

    let iframeReady = false;
    const readyHandler = (e: MessageEvent) => {
      if (e.data === 'FLASH_IFRAME_READY') {
        iframeReady = true;
      }
    };
    window.addEventListener('message', readyHandler);

    containerEl.appendChild(iframeContainer);
    iframeContainer.appendChild(iframe);
    if (!hideFullscreen) {
      iframeContainer.appendChild(fullscreenBtn);
    }

    const swfData = await swfPromise;

    if (!iframeReady) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('message', readyHandler);
          reject(new Error('Flash iframe ready timeout'));
        }, LOADING_TIMEOUT);

        const check = () => {
          if (iframeReady) {
            clearTimeout(timeout);
            window.removeEventListener('message', readyHandler);
            return resolve();
          }
          setTimeout(check, 10);
        };
        check();
      });
    }
    window.removeEventListener('message', readyHandler);

    iframe.contentWindow?.postMessage({ type: 'SWF_DATA', data: swfData }, '*', [swfData]);

    iframe.style.opacity = '1';
    if (loadingEl.parentNode) {
      loadingEl.style.opacity = '0';
      setTimeout(() => {
        if (loadingEl.parentNode) loadingEl.remove();
      }, 300);
    }

    const handle: FlashPlayerHandle = {
      destroy: () => {
        if (iframeContainer.parentNode) {
          iframeContainer.parentNode.removeChild(iframeContainer);
        }

        const btn = containerEl.querySelector('.flash-fullscreen-btn');
        if (btn) {
          btn.parentNode?.removeChild(btn);
        }

        URL.revokeObjectURL(htmlBlobUrl);
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
        color: var(--text-muted);
      ">
        <div style="font-size: 48px; margin-bottom: 16px;">⚡</div>
        <div style="font-weight: bold; margin-bottom: 8px;">${t('flash_player.error_heading')}</div>
        <div style="font-size: 14px;">${error instanceof Error ? error.message : t('common.error')}</div>
      </div>
    `;

    throw error;
  }
}

function createFlashLoadingIndicator(): HTMLElement {
  ensureSpinKeyframe();

  const loading = document.createElement('div');
  loading.className = 'flash-loading';
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
  text.textContent = t('post_stage.loading_flash').replace(/<[^>]+>/g, '');

  loading.appendChild(spinner);
  loading.appendChild(text);
  return loading;
}

function ensureSpinKeyframe(): void {
  if (!document.querySelector('#wvfs-spin-style')) {
    const style = document.createElement('style');
    style.id = 'wvfs-spin-style';
    style.textContent = `@keyframes wvfs-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}

export function isValidSwfFile(file: File): boolean {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext !== 'swf') return false;

  const validTypes = ['application/x-shockwave-flash', 'application/vnd.adobe.flash.movie'];
  if (file.type && !validTypes.includes(file.type)) {
    if (file.type !== '' && file.type !== 'application/octet-stream') return false;
  }

  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) return false;

  return true;
}

export async function validateSwfFile(file: File): Promise<boolean> {
  const header = await file.slice(0, 3).arrayBuffer();
  const headerStr = new TextDecoder().decode(header);
  return headerStr === 'FWS' || headerStr === 'CWS' || headerStr === 'ZWS';
}
