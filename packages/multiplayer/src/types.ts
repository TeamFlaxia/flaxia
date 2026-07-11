export interface PlayerInfo {
  userId: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
  isReady: boolean;
  isHost: boolean;
}

export interface RoomInfo {
  roomId: string;
  gameId: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  maxPlayers: number;
  isPublic: boolean;
  createdAt: number;
}

export interface RoomState {
  room: RoomInfo;
  players: PlayerInfo[];
}

export interface GameStateEvent {
  gameId: string;
  state: unknown;
  timestamp: number;
}

export interface PlayerInputEvent {
  userId: string;
  input: unknown;
}

export interface ChatEvent {
  userId: string;
  username: string;
  message: string;
}

export interface GameOverEvent {
  winner?: string;
  scores?: Record<string, number>;
}

export interface MultiplayerError {
  code: string;
  message: string;
}

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface MultiplayerEvents {
  onRoomState: (state: RoomState) => void;
  onPlayerJoined: (player: PlayerInfo) => void;
  onPlayerLeft: (userId: string) => void;
  onPlayerReady: (userId: string, ready: boolean) => void;
  onGameStart: () => void;
  onGameState: (event: GameStateEvent) => void;
  onPlayerInput: (event: PlayerInputEvent) => void;
  onGameOver: (event: GameOverEvent) => void;
  onHostChanged: (newHostId: string) => void;
  onChat: (event: ChatEvent) => void;
  onError: (error: MultiplayerError) => void;
  onDisconnect: () => void;
}

export interface MultiplayerClientOptions {
  gameId: string;
  roomId?: string;
  autoConnect?: boolean;
  allowedOrigins?: string[];
}
