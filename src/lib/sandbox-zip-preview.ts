import { isParentMessage, MAX_SANDBOX_ZIP_PREVIEW_BYTES, type SandboxMessage } from './bridge.js';
import { createZipLoadingIndicator, fadeOutLoading } from './zip-ui-utils.js';

const PREVIEW_TIMEOUT_MS = 30_000;

type SandboxZipRequest = Extract<SandboxMessage, { type: 'EXECUTE_ZIP' }>;

export interface SandboxZipPreviewHandle {
  destroy: () => void;
}

/** Run local game data on sandbox.flaxia.app, never on the main app origin. */
export function executeSandboxZipPreview(
  containerEl: HTMLElement,
  zipData: ArrayBuffer,
): Promise<SandboxZipPreviewHandle> {
  if (zipData.byteLength > MAX_SANDBOX_ZIP_PREVIEW_BYTES) {
    return Promise.reject(new Error('ZIP file exceeds the 10MB preview limit'));
  }

  containerEl.innerHTML = '';
  containerEl.style.position = 'relative';

  const postId = 'preview-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const sandboxOrigin = new URL(import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app').origin;
  const loadingEl = createZipLoadingIndicator('preview-sandbox');
  const iframe = document.createElement('iframe');
  iframe.className = 'file-preview-game-iframe';
  iframe.setAttribute('allow', 'fullscreen; web-share');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = 'width: 100%; height: 100%; border: none; opacity: 0;';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Sandbox ZIP preview timed out')), PREVIEW_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener('message', handleMessage);
      iframe.removeEventListener('load', handleLoad);
      loadingEl.remove();
      iframe.remove();
    };

    let requestSent = false;
    const request: SandboxZipRequest = { type: 'EXECUTE_ZIP', postId, zipData };
    const init: Extract<SandboxMessage, { type: 'PREVIEW_INIT' }> = { type: 'PREVIEW_INIT', requestId: postId };

    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.contentWindow || event.origin !== sandboxOrigin || !isParentMessage(event.data))
        return;

      if (event.data.type === 'ZIP_PREVIEW_READY' && event.data.requestId === postId) {
        iframe.removeEventListener('load', handleLoad);
        if (!requestSent) {
          requestSent = true;
          iframe.contentWindow?.postMessage(request, sandboxOrigin, [zipData]);
        }
        return;
      }
      if ((event.data.type !== 'ZIP_READY' && event.data.type !== 'ZIP_ERROR') || event.data.postId !== postId) return;

      if (event.data.type === 'ZIP_ERROR') {
        finish(new Error(event.data.error || 'Sandbox ZIP preview failed'));
        return;
      }

      clearTimeout(timeout);
      iframe.style.opacity = '1';
      fadeOutLoading(loadingEl);
      window.removeEventListener('message', handleMessage);
      resolve({ destroy: cleanup });
    };

    const handleLoad = () => {
      iframe.contentWindow?.postMessage(init, sandboxOrigin);
    };

    function finish(error: Error): void {
      cleanup();
      reject(error);
    }

    window.addEventListener('message', handleMessage);
    iframe.addEventListener('load', handleLoad);
    // This is a trusted cross-origin shell; only its nested game iframe is sandboxed.
    iframe.src = sandboxOrigin + '/zip-preview';
    containerEl.appendChild(loadingEl);
    containerEl.appendChild(iframe);
  });
}
