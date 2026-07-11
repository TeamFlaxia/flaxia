type WsMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'start_game' }
  | { type: 'leave' }
  | { type: 'input'; input: unknown; timestamp: number }
  | { type: 'chat'; message: string }
  | { type: 'request_state' };

interface MultiplayerConfig {
  gameId: string;
  roomId: string;
  wsUrl: string;
  iframe: HTMLIFrameElement;
  sandboxOrigin: string;
  onDisconnect?: () => void;
}

export class MultiplayerManager {
  private ws: WebSocket | null = null;
  private config: MultiplayerConfig;
  private connected = false;

  constructor(config: MultiplayerConfig) {
    this.config = config;
  }

  connect(): void {
    if (this.connected) return;

    const wsUrl = new URL(this.config.wsUrl, window.location.origin);
    wsUrl.searchParams.set('gameId', this.config.gameId);
    wsUrl.searchParams.set('roomId', this.config.roomId);

    this.ws = new WebSocket(wsUrl.toString().replace(/^http/, 'ws'));

    this.ws.addEventListener('open', () => {
      this.connected = true;
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data as string);
        this.relayToGame(data);
      } catch {
        // ignore invalid JSON
      }
    });

    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.relayToGame({ type: 'MULTIPLAYER_ERROR', code: 'DISCONNECTED', message: 'Connection closed' });
      this.config.onDisconnect?.();
    });

    this.ws.addEventListener('error', () => {
      this.connected = false;
      this.relayToGame({ type: 'MULTIPLAYER_ERROR', code: 'CONNECTION_ERROR', message: 'WebSocket connection error' });
    });
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, 'Game disconnected');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  handleGameMessage(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    switch (msg.type) {
      case 'MULTIPLAYER_INPUT':
        this.sendWs({ type: 'input', input: msg.input, timestamp: Date.now() });
        break;

      case 'MULTIPLAYER_START_GAME':
        this.sendWs({ type: 'start_game' });
        break;

      case 'MULTIPLAYER_SET_READY':
        this.sendWs({ type: 'ready', ready: !!msg.ready });
        break;

      case 'MULTIPLAYER_CHAT':
        this.sendWs({ type: 'chat', message: String(msg.message || '') });
        break;

      case 'MULTIPLAYER_REQUEST_STATE':
        this.sendWs({ type: 'request_state' });
        break;

      case 'MULTIPLAYER_DISCONNECT':
        this.disconnect();
        break;
    }
  }

  private sendWs(msg: WsMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private relayToGame(data: Record<string, unknown>): void {
    const msgType = data.type as string;
    let parentMsg: Record<string, unknown> | null = null;

    switch (msgType) {
      case 'room_state':
        parentMsg = {
          type: 'MULTIPLAYER_ROOM_STATE',
          room: data.room,
          players: data.players,
        };
        break;

      case 'player_joined':
        parentMsg = { type: 'MULTIPLAYER_PLAYER_JOINED', player: data.player };
        break;

      case 'player_left':
        parentMsg = { type: 'MULTIPLAYER_PLAYER_LEFT', userId: data.userId };
        break;

      case 'player_ready':
        parentMsg = { type: 'MULTIPLAYER_PLAYER_READY', userId: data.userId, ready: data.ready };
        break;

      case 'game_start':
        parentMsg = { type: 'MULTIPLAYER_GAME_START' };
        break;

      case 'game_state':
        parentMsg = {
          type: 'MULTIPLAYER_STATE',
          gameId: this.config.gameId,
          state: data.state,
          timestamp: data.timestamp,
        };
        break;

      case 'player_input':
        parentMsg = { type: 'MULTIPLAYER_PLAYER_INPUT', userId: data.userId, input: data.input };
        break;

      case 'game_over':
        parentMsg = {
          type: 'MULTIPLAYER_GAME_OVER',
          winner: data.winner,
          scores: data.scores,
        };
        break;

      case 'host_changed':
        parentMsg = { type: 'MULTIPLAYER_HOST_CHANGED', newHostId: data.newHostId };
        break;

      case 'chat':
        parentMsg = {
          type: 'MULTIPLAYER_CHAT',
          userId: data.userId,
          username: data.username,
          message: data.message,
        };
        break;

      case 'error':
        parentMsg = { type: 'MULTIPLAYER_ERROR', code: data.code, message: data.message };
        break;
    }

    if (parentMsg) {
      try {
        this.config.iframe.contentWindow?.postMessage(parentMsg, this.config.sandboxOrigin);
      } catch {
        // ignore
      }
    }
  }

  destroy(): void {
    this.disconnect();
  }
}
