import type { ParentMessage } from '../lib/bridge.js';
import { isParentMessage } from '../lib/bridge.js';
import { MultiplayerManager } from '../lib/multiplayer-manager.js';
import type { SandboxFrameProps } from '../types/post.js';

export function createSandboxFrame(props: SandboxFrameProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sandbox-frame-container';

  const iframe = document.createElement('iframe');
  iframe.className = 'sandbox-frame';
  const gameUrl = new URL(
    `/api/wvfs-zip/${encodeURIComponent(props.postId)}/index.html`,
    new URL(props.sandboxOrigin).origin,
  );
  if (props.versionId) gameUrl.searchParams.set('v', props.versionId);
  iframe.src = gameUrl.toString();
  iframe.sandbox = 'allow-scripts allow-pointer-lock allow-forms allow-popups';
  iframe.allow = 'fullscreen; web-share';
  iframe.referrerPolicy = 'no-referrer';

  let multiplayerManager: MultiplayerManager | null = null;

  const messageHandler = (event: MessageEvent) => {
    // The game's response CSP and iframe sandbox both give it an opaque origin.
    // Source identity is therefore the per-card boundary; the runtime schema
    // validates the message before any game or multiplayer action is handled.
    if (event.source !== iframe.contentWindow || event.origin !== 'null') return;

    const data: unknown = event.data;
    if (!isParentMessage(data)) return;

    if (data.type === 'MULTIPLAYER_CONNECT') {
      handleMultiplayerConnect(data, iframe, props, multiplayerManager, (mgr) => {
        multiplayerManager = mgr;
      });
      return;
    }

    if (multiplayerManager && data.type.startsWith('MULTIPLAYER_')) {
      multiplayerManager.handleGameMessage(data as unknown as Record<string, unknown>);
      return;
    }

    handleSandboxMessage(data, iframe);
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

function postToGame(iframe: HTMLIFrameElement, message: ParentMessage): void {
  if (!isParentMessage(message)) return;
  try {
    iframe.contentWindow?.postMessage(message, '*');
  } catch {
    // ignore
  }
}

function handleMultiplayerConnect(
  data: Extract<ParentMessage, { type: 'MULTIPLAYER_CONNECT' }>,
  iframe: HTMLIFrameElement,
  props: SandboxFrameProps,
  existing: MultiplayerManager | null,
  setManager: (mgr: MultiplayerManager) => void,
): void {
  if (existing) {
    existing.disconnect();
  }

  const gameId = data.gameId;
  const roomId = data.roomId;

  if (!gameId) {
    postToGame(iframe, { type: 'MULTIPLAYER_ERROR', code: 'INVALID_CONFIG', message: 'gameId is required' });
    return;
  }

  joinOrCreateRoom(gameId, roomId, props.postId)
    .then((result) => {
      if (!result) {
        postToGame(iframe, { type: 'MULTIPLAYER_ERROR', code: 'ROOM_JOIN_FAILED', message: 'Failed to join room' });
        return;
      }

      const manager = new MultiplayerManager({
        gameId,
        roomId: result.roomId,
        userId: result.userId,
        wsUrl: result.wsUrl,
        iframe,
      });
      setManager(manager);
      manager.connect();
    })
    .catch(() => {
      postToGame(iframe, { type: 'MULTIPLAYER_ERROR', code: 'ROOM_JOIN_FAILED', message: 'Failed to join room' });
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
