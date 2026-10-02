import { t } from './i18n.js';
import { ZIP_LOADING_TIMEOUT } from './zip-constants.js';

export interface ZipIframeHandle {
  iframe: HTMLIFrameElement;
  cleanup: () => void;
}

const ZIP_SANDBOX = 'allow-scripts allow-pointer-lock allow-fullscreen';

export function createZipLoadingIndicator(prefix: string): HTMLElement {
  ensureZipSpinKeyframe(prefix);

  const loading = document.createElement('div');
  loading.className = `${prefix}-loading`;
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
    animation: ${prefix}-spin 0.8s linear infinite;
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

export function ensureZipSpinKeyframe(prefix: string): void {
  if (!document.querySelector(`#${prefix}-spin-style`)) {
    const style = document.createElement('style');
    style.id = `${prefix}-spin-style`;
    style.textContent = `@keyframes ${prefix}-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}

export function createZipSandboxIframe(
  containerEl: HTMLElement,
  src: string,
  options: { hideFullscreen?: boolean; prefix?: string } = {},
): ZipIframeHandle {
  const { hideFullscreen = false, prefix = 'zip' } = options;

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
  iframe.src = src;
  iframe.sandbox = ZIP_SANDBOX;
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
  fullscreenBtn.className = `${prefix}-fullscreen-btn`;
  fullscreenBtn.style.cssText = `
    margin-top: 8px;
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

export function waitForZipIframeLoad(
  iframe: HTMLIFrameElement,
  loadingEl: HTMLElement | null,
  timeoutMs: number = ZIP_LOADING_TIMEOUT,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      iframe.removeEventListener('load', onLoad);
      resolve(false);
    }, timeoutMs);

    (iframe as HTMLIFrameElement & { _zipLoadTimeout?: number })._zipLoadTimeout = timeoutId;

    function onLoad() {
      clearTimeout(timeoutId);
      resolve(true);
    }

    iframe.addEventListener('load', onLoad, { once: true });
  });
}

export function fadeOutLoading(loadingEl: HTMLElement | null): void {
  if (loadingEl?.parentNode) {
    loadingEl.style.opacity = '0';
    setTimeout(() => {
      if (loadingEl?.parentNode) {
        loadingEl.remove();
      }
    }, 300);
  }
}

export function showLoadingTimeoutMessage(loadingEl: HTMLElement | null): void {
  if (loadingEl?.parentNode) {
    loadingEl.innerHTML = `<div style="color: var(--text-muted, #64748b); text-align: center; padding: 20px; font-size: 0.875rem;">読み込みに時間がかかっています…</div>`;
  }
}
