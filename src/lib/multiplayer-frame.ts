import { isParentMessage, type ParentMessage } from './bridge.js';
import { MultiplayerManager } from './multiplayer-manager.js';

export interface MultiplayerFrameHandle {
  destroy: () => void;
}

interface AttachOptions {
  /** Receives game messages that are not part of the multiplayer protocol. */
  onMessage?: (message: ParentMessage) => void;
}

interface JoinResult {
  roomId: string;
  userId: string;
  wsUrl: string;
}

function postToGame(iframe: HTMLIFrameElement, message: ParentMessage): void {
  if (!isParentMessage(message)) return;
  try {
    iframe.contentWindow?.postMessage(message, '*');
  } catch {
    // The frame may have been removed while the request was in flight.
  }
}

async function joinOrCreateRoom(gameId: string, roomId: string | undefined): Promise<JoinResult | null> {
  try {
    if (roomId) {
      const joinResp = await fetch(`/api/multiplayer/rooms/${roomId}/join`, { method: 'POST' });
      if (!joinResp.ok) return null;
      return (await joinResp.json()) as JoinResult;
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
    return (await joinResp.json()) as JoinResult;
  } catch {
    return null;
  }
}

/**
 * Connects a sandboxed game frame to the multiplayer room API.
 *
 * Every game runtime must use this: the ZIP/WVFS player used to create its
 * iframe without the bridge, so `MULTIPLAYER_CONNECT` was silently ignored and
 * online play never left the lobby. The frame's CSP sandbox gives it an opaque
 * origin, so `event.source` is the identity check.
 */
export function attachMultiplayerFrame(iframe: HTMLIFrameElement, options: AttachOptions = {}): MultiplayerFrameHandle {
  let manager: MultiplayerManager | null = null;
  let destroyed = false;

  const messageHandler = (event: MessageEvent) => {
    if (destroyed) return;
    if (event.source !== iframe.contentWindow || event.origin !== 'null') return;

    const data: unknown = event.data;
    if (!isParentMessage(data)) return;

    if (data.type === 'MULTIPLAYER_CONNECT') {
      manager?.destroy();
      manager = null;

      if (!data.gameId) {
        postToGame(iframe, { type: 'MULTIPLAYER_ERROR', code: 'INVALID_CONFIG', message: 'gameId is required' });
        return;
      }

      const gameId = data.gameId;
      void joinOrCreateRoom(gameId, data.roomId)
        .then((result) => {
          if (destroyed) return;
          if (!result) {
            postToGame(iframe, { type: 'MULTIPLAYER_ERROR', code: 'ROOM_JOIN_FAILED', message: 'Failed to join room' });
            return;
          }

          const next = new MultiplayerManager({
            gameId,
            roomId: result.roomId,
            userId: result.userId,
            wsUrl: result.wsUrl,
            iframe,
          });
          manager = next;
          next.connect();
        })
        .catch(() => {
          if (destroyed) return;
          postToGame(iframe, { type: 'MULTIPLAYER_ERROR', code: 'ROOM_JOIN_FAILED', message: 'Failed to join room' });
        });
      return;
    }

    if (manager && data.type.startsWith('MULTIPLAYER_')) {
      manager.handleGameMessage(data as unknown as Record<string, unknown>);
      return;
    }

    options.onMessage?.(data);
  };

  window.addEventListener('message', messageHandler);

  return {
    destroy: () => {
      destroyed = true;
      window.removeEventListener('message', messageHandler);
      manager?.destroy();
      manager = null;
    },
  };
}
