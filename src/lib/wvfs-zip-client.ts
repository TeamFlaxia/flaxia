import { t } from './i18n.js';

export interface WvfsZipExecutorHandle {
  destroy: () => void;
  postId: string;
}

// Global execution manager
let activeHandle: WvfsZipExecutorHandle | null = null;

export async function executeWvfsZip(
  postId: string,
  containerEl: HTMLElement,
  workerUrl?: string, // custom worker URL for testing
  hideFullscreen: boolean = false,
): Promise<WvfsZipExecutorHandle> {
  // Clean up any existing execution
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    // Create iframe pointing directly to WVFS sandbox worker (bypass 301 redirect)
    const sandboxOrigin = workerUrl || import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';
    const zipUrl = `${sandboxOrigin}/api/wvfs-zip/${postId}`;

    const { cleanup } = await createWvfsIframe(postId, containerEl, zipUrl, hideFullscreen);

    // Create handle with cleanup
    const handle: WvfsZipExecutorHandle = {
      postId,
      destroy: () => {
        cleanup();

        // Remove fullscreen button if it exists
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
    // Clean up on error
    if (activeHandle) {
      activeHandle.destroy();
      activeHandle = null;
    }
    throw error;
  }
}

async function createWvfsIframe(
  postId: string,
  containerEl: HTMLElement,
  zipUrl: string,
  hideFullscreen: boolean = false,
): Promise<{ iframe: HTMLIFrameElement; cleanup: () => void }> {
  // Create iframe container
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

  // Create iframe pointing to WVFS worker endpoint
  const iframe = document.createElement('iframe');
  iframe.src = zipUrl;
  iframe.setAttribute('allow', 'fullscreen');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  `;

  // Add fullscreen button
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
      if (iframeContainer.requestFullscreen) {
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

  // Clear container and add iframe container
  containerEl.innerHTML = '';
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
