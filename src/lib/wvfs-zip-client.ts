import {
  createZipLoadingIndicator,
  createZipSandboxIframe,
  fadeOutLoading,
  showLoadingTimeoutMessage,
  waitForZipIframeLoad,
} from './zip-ui-utils.js';
import { connectGameStorage, loadLegacyGameStorage } from './game-storage-broker.js';

export interface WvfsZipExecutorHandle {
  destroy: () => void;
  postId: string;
}

const PREFIX = 'wvfs';

let activeHandle: WvfsZipExecutorHandle | null = null;

export async function executeWvfsZip(
  postId: string,
  containerEl: HTMLElement,
  workerUrl?: string,
  hideFullscreen: boolean = false,
  showLoading: boolean = true,
  versionId?: string,
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
      loadingEl = createZipLoadingIndicator(PREFIX);
      containerEl.appendChild(loadingEl);
    }

    const sandboxOrigin = workerUrl || import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';
    const zipUrl = `${sandboxOrigin}/api/wvfs-zip/${postId}${versionId ? `?v=${versionId}` : ''}`;
    const preWarmUrl = `${zipUrl}/index.html`;
    fetch(preWarmUrl, { method: 'GET', mode: 'cors' }).catch(() => {});

    let storageSnapshot: Record<string, string> = {};
    try {
      storageSnapshot = await loadLegacyGameStorage(sandboxOrigin);
    } catch (error) {
      console.warn('Legacy game storage is unavailable:', error);
    }

    const { iframe, cleanup } = createZipSandboxIframe(containerEl, zipUrl, {
      hideFullscreen,
      prefix: PREFIX,
      storageSnapshot,
    });
    const disconnectStorage = connectGameStorage(iframe, sandboxOrigin);

    const loaded = await waitForZipIframeLoad(iframe, loadingEl);

    if (loaded) {
      iframe.style.opacity = '1';
      fadeOutLoading(loadingEl);
    } else {
      showLoadingTimeoutMessage(loadingEl);
      iframe.style.opacity = '1';
    }

    const handle: WvfsZipExecutorHandle = {
      postId,
      destroy: () => {
        clearTimeout((iframe as HTMLIFrameElement & { _zipLoadTimeout?: number })._zipLoadTimeout);
        disconnectStorage();
        cleanup();
        const fullscreenBtn = containerEl.querySelector(`.${PREFIX}-fullscreen-btn`);
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
