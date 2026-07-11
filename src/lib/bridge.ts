export type PlayerInfo = {
  userId: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
  isReady: boolean;
  isHost: boolean;
};

export type RoomInfo = {
  roomId: string;
  gameId: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  maxPlayers: number;
  isPublic: boolean;
  createdAt: number;
};

export type ParentMessage =
  | { type: 'REQUEST_FULLSCREEN' }
  | { type: 'REQUEST_FRESH' }
  | { type: 'POST_SCORE'; score: number; label: string }
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

export type SandboxMessage =
  | { type: 'FULLSCREEN_GRANTED' }
  | { type: 'FULLSCREEN_DENIED' }
  | { type: 'FRESH_GRANTED' }
  | { type: 'FRESH_DENIED' }
  | { type: 'SCORE_SUBMITTED'; score: number; label: string }
  | { type: 'MULTIPLAYER_CONNECT'; gameId: string; roomId?: string }
  | { type: 'MULTIPLAYER_DISCONNECT' }
  | { type: 'MULTIPLAYER_INPUT'; input: unknown; timestamp: number }
  | { type: 'MULTIPLAYER_START_GAME' }
  | { type: 'MULTIPLAYER_SET_READY'; ready: boolean }
  | { type: 'MULTIPLAYER_CHAT'; message: string }
  | { type: 'MULTIPLAYER_REQUEST_STATE' }
  | { type: 'MULTIPLAYER_SEND_PEER_DATA'; data: unknown };

function isRecord(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

export function isParentMessage(msg: unknown): msg is ParentMessage {
  if (!isRecord(msg)) return false;

  switch (msg.type) {
    case 'REQUEST_FULLSCREEN':
    case 'REQUEST_FRESH':
      return true;
    case 'POST_SCORE':
      return typeof msg.score === 'number' && !Number.isNaN(msg.score) && typeof msg.label === 'string';
    case 'MULTIPLAYER_STATE':
      return typeof msg.gameId === 'string';
    case 'MULTIPLAYER_ROOM_STATE':
      return isRecord(msg.room);
    case 'MULTIPLAYER_PLAYER_JOINED':
      return isRecord(msg.player);
    case 'MULTIPLAYER_PLAYER_LEFT':
    case 'MULTIPLAYER_PLAYER_READY':
    case 'MULTIPLAYER_GAME_START':
    case 'MULTIPLAYER_GAME_OVER':
    case 'MULTIPLAYER_PLAYER_INPUT':
    case 'MULTIPLAYER_HOST_CHANGED':
    case 'MULTIPLAYER_CHAT':
    case 'MULTIPLAYER_ERROR':
    case 'MULTIPLAYER_P2P_STATE':
    case 'MULTIPLAYER_PEER_DATA':
      return true;
    default:
      return false;
  }
}

export function isSandboxMessage(msg: unknown): msg is SandboxMessage {
  if (!isRecord(msg)) return false;

  switch (msg.type) {
    case 'FULLSCREEN_GRANTED':
    case 'FULLSCREEN_DENIED':
    case 'FRESH_GRANTED':
    case 'FRESH_DENIED':
      return true;
    case 'SCORE_SUBMITTED':
      return typeof msg.score === 'number' && !Number.isNaN(msg.score) && typeof msg.label === 'string';
    case 'MULTIPLAYER_CONNECT':
      return typeof msg.gameId === 'string';
    case 'MULTIPLAYER_DISCONNECT':
    case 'MULTIPLAYER_INPUT':
    case 'MULTIPLAYER_START_GAME':
    case 'MULTIPLAYER_SET_READY':
    case 'MULTIPLAYER_CHAT':
    case 'MULTIPLAYER_REQUEST_STATE':
    case 'MULTIPLAYER_SEND_PEER_DATA':
      return true;
    default:
      return false;
  }
}
