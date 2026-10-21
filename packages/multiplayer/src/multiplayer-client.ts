import type {
  ChatEvent,
  GameOverEvent,
  GameStateEvent,
  MultiplayerError,
  MultiplayerEvents,
  P2PStateEvent,
  PeerDataEvent,
  PlayerInfo,
  PlayerInputEvent,
  RoomInfo,
  RoomState,
} from './types.ts';

export interface MultiplayerClientOptions {
  gameId: string;
  roomId?: string;
  autoConnect?: boolean;
  allowedOrigins?: string[];
}

type SandboxMessage =
  | { type: 'MULTIPLAYER_CONNECT'; gameId: string; roomId?: string }
  | { type: 'MULTIPLAYER_DISCONNECT' }
  | { type: 'MULTIPLAYER_INPUT'; input: unknown; timestamp: number }
  | { type: 'MULTIPLAYER_START_GAME' }
  | { type: 'MULTIPLAYER_SET_READY'; ready: boolean }
  | { type: 'MULTIPLAYER_CHAT'; message: string }
  | { type: 'MULTIPLAYER_REQUEST_STATE' }
  | { type: 'MULTIPLAYER_SEND_PEER_DATA'; data: unknown };

type ParentMessage =
  | { type: 'MULTIPLAYER_STATE'; gameId: string; state: unknown; timestamp: number }
  | { type: 'MULTIPLAYER_ROOM_STATE'; room: RoomInfo; players: PlayerInfo[] }
  | { type: 'MULTIPLAYER_PLAYER_JOINED'; player: PlayerInfo }
  | { type: 'MULTIPLAYER_PLAYER_LEFT'; userId: string }
  | { type: 'MULTIPLAYER_PLAYER_READY'; userId: string; ready: boolean }
  | { type: 'MULTIPLAYER_GAME_START' }
  | { type: 'MULTIPLAYER_GAME_OVER'; winner?: string; scores?: Record<string, number> }
  | { type: 'MULTIPLAYER_PLAYER_INPUT'; userId: string; input: unknown }
  | { type: 'MULTIPLAYER_HOST_CHANGED'; newHostId: string }
  | { type: 'MULTIPLAYER_CHAT'; userId: string; username: string; message: string }
  | { type: 'MULTIPLAYER_ERROR'; code: string; message: string }
  | { type: 'MULTIPLAYER_P2P_STATE'; state: 'connected' | 'disconnected' | 'failed'; peerId?: string }
  | { type: 'MULTIPLAYER_PEER_DATA'; data: unknown };

export class MultiplayerClient {
  private gameId: string;
  private roomId: string | null = null;
  private connected = false;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private allowedOrigins: string[];
  private targetOrigin: string;

  private onRoomState: ((state: RoomState) => void) | null = null;
  private onPlayerJoined: ((player: PlayerInfo) => void) | null = null;
  private onPlayerLeft: ((userId: string) => void) | null = null;
  private onPlayerReady: ((userId: string, ready: boolean) => void) | null = null;
  private onGameStart: (() => void) | null = null;
  private onGameState: ((event: GameStateEvent) => void) | null = null;
  private onPlayerInput: ((event: PlayerInputEvent) => void) | null = null;
  private onGameOver: ((event: GameOverEvent) => void) | null = null;
  private onHostChanged: ((newHostId: string) => void) | null = null;
  private onChat: ((event: ChatEvent) => void) | null = null;
  private onError: ((error: MultiplayerError) => void) | null = null;
  private onDisconnect: (() => void) | null = null;
  private onP2PState: ((event: P2PStateEvent) => void) | null = null;
  private onPeerData: ((event: PeerDataEvent) => void) | null = null;

  constructor(options: MultiplayerClientOptions) {
    this.gameId = options.gameId;
    if (options.roomId) {
      this.roomId = options.roomId;
    }
    this.allowedOrigins = options.allowedOrigins || ['https://flaxia.app', 'https://*.flaxia.app'];
    this.targetOrigin = this.allowedOrigins[0];

    if (options.autoConnect !== false) {
      this.connect();
    }
  }

  connect(roomId?: string): void {
    if (this.connected) return;

    if (roomId) {
      this.roomId = roomId;
    }

    this.messageHandler = this.handleMessage.bind(this);
    window.addEventListener('message', this.messageHandler);

    const msg: SandboxMessage = {
      type: 'MULTIPLAYER_CONNECT',
      gameId: this.gameId,
      roomId: this.roomId || undefined,
    };
    this.postMessage(msg);
    this.connected = true;
  }

  disconnect(): void {
    if (!this.connected) return;

    const msg: SandboxMessage = { type: 'MULTIPLAYER_DISCONNECT' };
    this.postMessage(msg);

    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.connected = false;
    this.onDisconnect?.();
  }

  sendInput(input: unknown): void {
    if (!this.connected) return;

    const msg: SandboxMessage = {
      type: 'MULTIPLAYER_INPUT',
      input,
      timestamp: Date.now(),
    };
    this.postMessage(msg);
  }

  startGame(): void {
    if (!this.connected) return;

    const msg: SandboxMessage = { type: 'MULTIPLAYER_START_GAME' };
    this.postMessage(msg);
  }

  setReady(ready: boolean): void {
    if (!this.connected) return;

    const msg: SandboxMessage = { type: 'MULTIPLAYER_SET_READY', ready };
    this.postMessage(msg);
  }

  sendChat(message: string): void {
    if (!this.connected) return;

    const msg: SandboxMessage = { type: 'MULTIPLAYER_CHAT', message };
    this.postMessage(msg);
  }

  requestState(): void {
    if (!this.connected) return;

    const msg: SandboxMessage = { type: 'MULTIPLAYER_REQUEST_STATE' };
    this.postMessage(msg);
  }

  sendPeerData(data: unknown): void {
    if (!this.connected) return;

    const msg: SandboxMessage = { type: 'MULTIPLAYER_SEND_PEER_DATA', data };
    this.postMessage(msg);
  }

  on<K extends keyof MultiplayerEvents>(event: K, handler: MultiplayerEvents[K]): void {
    switch (event) {
      case 'onRoomState':
        this.onRoomState = handler as typeof this.onRoomState;
        break;
      case 'onPlayerJoined':
        this.onPlayerJoined = handler as typeof this.onPlayerJoined;
        break;
      case 'onPlayerLeft':
        this.onPlayerLeft = handler as typeof this.onPlayerLeft;
        break;
      case 'onPlayerReady':
        this.onPlayerReady = handler as typeof this.onPlayerReady;
        break;
      case 'onGameStart':
        this.onGameStart = handler as typeof this.onGameStart;
        break;
      case 'onGameState':
        this.onGameState = handler as typeof this.onGameState;
        break;
      case 'onPlayerInput':
        this.onPlayerInput = handler as typeof this.onPlayerInput;
        break;
      case 'onGameOver':
        this.onGameOver = handler as typeof this.onGameOver;
        break;
      case 'onHostChanged':
        this.onHostChanged = handler as typeof this.onHostChanged;
        break;
      case 'onChat':
        this.onChat = handler as typeof this.onChat;
        break;
      case 'onError':
        this.onError = handler as typeof this.onError;
        break;
      case 'onDisconnect':
        this.onDisconnect = handler as typeof this.onDisconnect;
        break;
      case 'onP2PState':
        this.onP2PState = handler as typeof this.onP2PState;
        break;
      case 'onPeerData':
        this.onPeerData = handler as typeof this.onPeerData;
        break;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  private handleMessage(event: MessageEvent): void {
    if (!this.isOriginAllowed(event.origin)) return;

    const data = event.data as ParentMessage;
    if (typeof data !== 'object' || data === null) return;

    switch (data.type) {
      case 'MULTIPLAYER_ROOM_STATE':
        this.roomId = data.room.roomId;
        this.onRoomState?.({ room: data.room, players: data.players });
        break;

      case 'MULTIPLAYER_PLAYER_JOINED':
        this.onPlayerJoined?.(data.player);
        break;

      case 'MULTIPLAYER_PLAYER_LEFT':
        this.onPlayerLeft?.(data.userId);
        break;

      case 'MULTIPLAYER_PLAYER_READY':
        this.onPlayerReady?.(data.userId, data.ready);
        break;

      case 'MULTIPLAYER_GAME_START':
        this.onGameStart?.();
        break;

      case 'MULTIPLAYER_STATE':
        this.onGameState?.({ gameId: data.gameId, state: data.state, timestamp: data.timestamp });
        break;

      case 'MULTIPLAYER_PLAYER_INPUT':
        this.onPlayerInput?.({ userId: data.userId, input: data.input });
        break;

      case 'MULTIPLAYER_GAME_OVER':
        this.onGameOver?.({ winner: data.winner, scores: data.scores });
        break;

      case 'MULTIPLAYER_HOST_CHANGED':
        this.onHostChanged?.(data.newHostId);
        break;

      case 'MULTIPLAYER_CHAT':
        this.onChat?.({ userId: data.userId, username: data.username, message: data.message });
        break;

      case 'MULTIPLAYER_ERROR':
        this.onError?.({ code: data.code, message: data.message });
        break;

      case 'MULTIPLAYER_P2P_STATE':
        this.onP2PState?.({ state: data.state, peerId: data.peerId });
        break;

      case 'MULTIPLAYER_PEER_DATA':
        this.onPeerData?.({ data: data.data });
        break;
    }
  }

  private isOriginAllowed(origin: string): boolean {
    return this.allowedOrigins.some((allowed) => {
      if (allowed.includes('*')) {
        const escaped = allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
        return new RegExp(`^${escaped}$`).test(origin);
      }
      return origin === allowed;
    });
  }

  private postMessage(msg: SandboxMessage): void {
    window.parent.postMessage(msg, this.targetOrigin);
  }
}
