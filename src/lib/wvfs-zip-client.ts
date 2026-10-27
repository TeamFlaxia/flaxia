import { connectGameStorage, loadLegacyGameStorage } from './game-storage-broker.js';
import { isNativeApp } from './native-api.ts';
import { createWvfsGameUrl } from './wvfs-game-url.js';
import {
  createZipLoadingIndicator,
  createZipSandboxIframe,
  fadeOutLoading,
  showLoadingTimeoutMessage,
  waitForZipIframeLoad,
} from './zip-ui-utils.js';

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
  preloadedStorage?: Promise<Record<string, string>>,
): Promise<WvfsZipExecutorHandle> {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    containerEl.innerHTML = '';
    containerEl.style.position = 'relative';

    if (isNativeApp()) {
      const { executeDownloadedGame } = await import('./offline-game-player.ts');
      const downloaded = await executeDownloadedGame(postId, containerEl, versionId).catch((error: unknown) => {
        // The local runtime supports fewer game formats than the online player.
        // Preserve the explicit compatibility error when no fallback is reachable.
        if (navigator.onLine === false) throw error;
        return undefined;
      });
      if (downloaded) {
        activeHandle = downloaded;
        return downloaded;
      }
      if (navigator.onLine === false) throw new Error('This game has not been downloaded');
    }

    let loadingEl: HTMLElement | null = null;
    if (showLoading) {
      loadingEl = createZipLoadingIndicator(PREFIX);
      containerEl.appendChild(loadingEl);
    }

    const sandboxOrigin = workerUrl || import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';
    const zipUrl = createWvfsGameUrl(sandboxOrigin, postId, { versionId });

    let storageSnapshot: Record<string, string> = {};
    try {
      storageSnapshot = await (preloadedStorage ?? loadLegacyGameStorage(sandboxOrigin, postId));
    } catch (error) {
      console.warn('Legacy game storage is unavailable:', error);
    }

    const { iframe, cleanup } = createZipSandboxIframe(containerEl, zipUrl, {
      hideFullscreen,
      prefix: PREFIX,
      storageSnapshot,
    });
    const disconnectStorage = connectGameStorage(iframe, postId);

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
