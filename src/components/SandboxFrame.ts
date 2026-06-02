import { isParentMessage, ParentMessage } from '../lib/bridge.js';
import { SandboxFrameProps } from '../types/post.js';

export function createSandboxFrame(props: SandboxFrameProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sandbox-frame-container';

  const iframe = document.createElement('iframe');
  iframe.className = 'sandbox-frame';
  iframe.src = `${props.sandboxOrigin}/run/${props.postId}`;
  iframe.sandbox = 'allow-scripts allow-forms allow-popups';
  iframe.allow = 'fullscreen; web-share';
  iframe.referrerPolicy = 'no-referrer';

  // Set up postMessage listener
  const messageHandler = (event: MessageEvent) => {
    if (event.origin !== props.sandboxOrigin) return;

    if (!isParentMessage(event.data)) return;

    handleSandboxMessage(event.data, iframe);
  };

  window.addEventListener('message', messageHandler);

  // Cleanup listener when element is removed
  const observer = new MutationObserver(() => {
    if (!document.contains(container)) {
      window.removeEventListener('message', messageHandler);
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  container.appendChild(iframe);
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
      // Forward to parent component to handle Fresh! logic
      window.dispatchEvent(
        new CustomEvent('sandboxRequestFresh', {
          detail: message,
        }),
      );
      break;

    case 'POST_SCORE':
      // Handle score submission
      window.dispatchEvent(
        new CustomEvent('sandboxPostScore', {
          detail: message,
        }),
      );
      break;
  }
}
