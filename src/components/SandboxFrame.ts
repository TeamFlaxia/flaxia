import type { SandboxFrameProps } from '../../shared/types/post.ts';
import { createWvfsGameUrl } from '../../shared/wvfs-game-url.ts';
import type { ParentMessage } from '../lib/bridge.js';
import { registerGameFrame } from '../lib/game-badge-bridge.js';
import { attachMultiplayerFrame } from '../lib/multiplayer-frame.js';

export function createSandboxFrame(props: SandboxFrameProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sandbox-frame-container';

  const iframe = document.createElement('iframe');
  iframe.className = 'sandbox-frame';
  iframe.src = createWvfsGameUrl(props.sandboxOrigin, props.postId, { versionId: props.versionId, index: true });
  iframe.sandbox = 'allow-scripts allow-pointer-lock allow-forms allow-popups';
  iframe.allow = 'fullscreen; web-share';
  iframe.referrerPolicy = 'no-referrer';

  let unregisterFrame: (() => void) | null = null;
  const multiplayer = attachMultiplayerFrame(iframe, {
    onMessage: (message) => handleSandboxMessage(message, iframe),
  });

  const observer = new MutationObserver(() => {
    if (!document.contains(container)) {
      multiplayer.destroy();
      unregisterFrame?.();
      unregisterFrame = null;
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  container.appendChild(iframe);
  unregisterFrame = registerGameFrame(iframe, props.postId);
  return container;
}

function handleSandboxMessage(message: ParentMessage, iframe: HTMLIFrameElement): void {
  switch (message.type) {
    case 'REQUEST_FULLSCREEN':
      if (iframe.requestFullscreen) {
        iframe.requestFullscreen();
      } else {
        const webkitIframe = iframe as HTMLIFrameElement & { webkitRequestFullscreen?: () => Promise<void> };
        if (webkitIframe.webkitRequestFullscreen) {
          webkitIframe.webkitRequestFullscreen();
        }
      }
      break;

    case 'REQUEST_FRESH':
      window.dispatchEvent(
        new CustomEvent('sandboxRequestFresh', {
          detail: message,
        }),
      );
      break;

    case 'POST_SCORE':
      window.dispatchEvent(
        new CustomEvent('sandboxPostScore', {
          detail: message,
        }),
      );
      break;
  }
}
