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

export type CaptureFrame = {
  width: number;
  height: number;
  ts: number;
  data: ArrayBuffer;
};

export type ParentMessage =
  | { type: 'REQUEST_FULLSCREEN' }
  | { type: 'REQUEST_FRESH' }
  | { type: 'POST_SCORE'; score: number; label: string }
  | { type: 'CAPTURE_READY'; ok: boolean }
  | { type: 'CAPTURE_FRAME_RESULT'; requestId: string; mime: string; data: ArrayBuffer }
  | { type: 'CAPTURE_GIF_RESULT'; requestId: string; frames: CaptureFrame[] }
  | { type: 'CAPTURE_ERROR'; requestId: string; message: string }
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
  | { type: 'CAPTURE_INIT' }
  | { type: 'CAPTURE_FRAME'; requestId: string }
  | { type: 'CAPTURE_GIF'; requestId: string }
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
    case 'CAPTURE_READY':
      return typeof msg.ok === 'boolean';
    case 'CAPTURE_FRAME_RESULT':
      return typeof msg.requestId === 'string' && typeof msg.mime === 'string' && msg.data instanceof ArrayBuffer;
    case 'CAPTURE_GIF_RESULT':
      return typeof msg.requestId === 'string' && Array.isArray(msg.frames);
    case 'CAPTURE_ERROR':
      return typeof msg.requestId === 'string' && typeof msg.message === 'string';
    case 'MULTIPLAYER_STATE':
      return typeof msg.gameId === 'string' && isRecord(msg.state) && typeof msg.timestamp === 'number';
    case 'MULTIPLAYER_ROOM_STATE':
      return (
        isRecord(msg.room) &&
        typeof msg.room.roomId === 'string' &&
        typeof msg.room.gameId === 'string' &&
        Array.isArray(msg.players)
      );
    case 'MULTIPLAYER_PLAYER_JOINED':
      return isRecord(msg.player) && typeof msg.player.userId === 'string';
    case 'MULTIPLAYER_PLAYER_LEFT':
      return typeof msg.userId === 'string';
    case 'MULTIPLAYER_PLAYER_READY':
      return typeof msg.userId === 'string' && typeof msg.ready === 'boolean';
    case 'MULTIPLAYER_GAME_START':
      return true;
    case 'MULTIPLAYER_GAME_OVER':
      return true;
    case 'MULTIPLAYER_PLAYER_INPUT':
      return typeof msg.userId === 'string' && 'input' in msg;
    case 'MULTIPLAYER_HOST_CHANGED':
      return typeof msg.newHostId === 'string';
    case 'MULTIPLAYER_CHAT':
      return typeof msg.userId === 'string' && typeof msg.username === 'string' && typeof msg.message === 'string';
    case 'MULTIPLAYER_ERROR':
      return typeof msg.code === 'string' && typeof msg.message === 'string';
    case 'MULTIPLAYER_P2P_STATE':
      return msg.state === 'connected' || msg.state === 'disconnected' || msg.state === 'failed';
    case 'MULTIPLAYER_PEER_DATA':
      return 'data' in msg;
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
    case 'CAPTURE_INIT':
      return true;
    case 'CAPTURE_FRAME':
    case 'CAPTURE_GIF':
      return typeof msg.requestId === 'string';
    case 'MULTIPLAYER_CONNECT':
      return typeof msg.gameId === 'string' && (msg.roomId === undefined || typeof msg.roomId === 'string');
    case 'MULTIPLAYER_DISCONNECT':
      return true;
    case 'MULTIPLAYER_INPUT':
      return 'input' in msg && typeof msg.timestamp === 'number';
    case 'MULTIPLAYER_START_GAME':
      return true;
    case 'MULTIPLAYER_SET_READY':
      return typeof msg.ready === 'boolean';
    case 'MULTIPLAYER_CHAT':
      return typeof msg.message === 'string' && msg.message.length <= 500;
    case 'MULTIPLAYER_REQUEST_STATE':
      return true;
    case 'MULTIPLAYER_SEND_PEER_DATA':
      return 'data' in msg;
    default:
      return false;
  }
}
