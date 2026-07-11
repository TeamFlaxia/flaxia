import { isParentMessage, ParentMessage } from '../lib/bridge.js';
import { MultiplayerManager } from '../lib/multiplayer-manager.js';
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

  let multiplayerManager: MultiplayerManager | null = null;

  const messageHandler = (event: MessageEvent) => {
    if (event.origin !== props.sandboxOrigin) return;

    const data = event.data as Record<string, unknown>;

    if (data.type === 'MULTIPLAYER_CONNECT') {
      handleMultiplayerConnect(data, iframe, props, multiplayerManager, (mgr) => {
        multiplayerManager = mgr;
      });
      return;
    }

    if (multiplayerManager && typeof data.type === 'string' && data.type.startsWith('MULTIPLAYER_')) {
      multiplayerManager.handleGameMessage(data);
      return;
    }

    if (!isParentMessage(data)) return;

    handleSandboxMessage(data as ParentMessage, iframe);
  };

  window.addEventListener('message', messageHandler);

  const observer = new MutationObserver(() => {
    if (!document.contains(container)) {
      window.removeEventListener('message', messageHandler);
      multiplayerManager?.destroy();
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  container.appendChild(iframe);
  return container;
}

function handleMultiplayerConnect(
  data: Record<string, unknown>,
  iframe: HTMLIFrameElement,
  props: SandboxFrameProps,
  existing: MultiplayerManager | null,
  setManager: (mgr: MultiplayerManager) => void,
): void {
  if (existing) {
    existing.disconnect();
  }

  const gameId = data.gameId as string;
  const roomId = data.roomId as string | undefined;

  if (!gameId) {
    try {
      iframe.contentWindow?.postMessage(
        { type: 'MULTIPLAYER_ERROR', code: 'INVALID_CONFIG', message: 'gameId is required' },
        props.sandboxOrigin,
      );
    } catch {
      // ignore
    }
    return;
  }

  joinOrCreateRoom(gameId, roomId, props.postId)
    .then((result) => {
      if (!result) {
        try {
          iframe.contentWindow?.postMessage(
            { type: 'MULTIPLAYER_ERROR', code: 'ROOM_JOIN_FAILED', message: 'Failed to join room' },
            props.sandboxOrigin,
          );
        } catch {
          // ignore
        }
        return;
      }

      const manager = new MultiplayerManager({
        gameId,
        roomId: result.roomId,
        userId: result.userId,
        wsUrl: result.wsUrl,
        iframe,
        sandboxOrigin: props.sandboxOrigin,
      });
      setManager(manager);
      manager.connect();
    })
    .catch(() => {
      try {
        iframe.contentWindow?.postMessage(
          { type: 'MULTIPLAYER_ERROR', code: 'ROOM_JOIN_FAILED', message: 'Failed to join room' },
          props.sandboxOrigin,
        );
      } catch {
        // ignore
      }
    });
}

async function joinOrCreateRoom(
  gameId: string,
  roomId: string | undefined,
  postId: string,
): Promise<{ roomId: string; userId: string; wsUrl: string } | null> {
  try {
    if (roomId) {
      const joinResp = await fetch(`/api/multiplayer/rooms/${roomId}/join`, { method: 'POST' });
      if (!joinResp.ok) return null;
      const joinData = (await joinResp.json()) as { roomId: string; userId: string; wsUrl: string };
      return joinData;
    }

    const createResp = await fetch('/api/multiplayer/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, maxPlayers: 2, isPublic: true }),
    });
    if (!createResp.ok) return null;
    const createData = (await createResp.json()) as { roomId: string };

    const joinResp = await fetch(`/api/multiplayer/rooms/${createData.roomId}/join`, { method: 'POST' });
    if (!joinResp.ok) return null;
    const joinData = (await joinResp.json()) as { roomId: string; userId: string; wsUrl: string };
    return joinData;
  } catch {
    return null;
  }
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
