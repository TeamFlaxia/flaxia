import {
  isParentZipPreviewMessage,
  isPreviewFullscreenRequest,
  isSandboxZipPreviewMessage,
} from '../../sandbox/zip-preview-protocol.js';

export { MAX_SANDBOX_ZIP_PREVIEW_BYTES } from '../../sandbox/zip-preview-protocol.js';

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
  | { type: 'DOCUMENT_READY'; requestId: string }
  | { type: 'VIEWER_CLOSE'; requestId: string }
  | { type: 'VIEWER_DOWNLOAD'; requestId: string }
  | { type: 'CAPTURE_READY'; ok: boolean }
  | { type: 'CAPTURE_FRAME_RESULT'; requestId: string; mime: string; data: ArrayBuffer }
  | { type: 'CAPTURE_GIF_RESULT'; requestId: string; frames: CaptureFrame[] }
  | { type: 'CAPTURE_ERROR'; requestId: string; message: string }
  | { type: 'ZIP_PREVIEW_READY'; requestId: string }
  | { type: 'ZIP_READY'; postId: string }
  | { type: 'ZIP_ERROR'; postId: string; error: string }
  | { type: 'MULTIPLAYER_STATE'; gameId: string; state: unknown; timestamp: number }
  | { type: 'MULTIPLAYER_ROOM_STATE'; room: RoomInfo; players: PlayerInfo[] }
  | { type: 'MULTIPLAYER_PLAYER_JOINED'; player: PlayerInfo }
  | { type: 'MULTIPLAYER_PLAYER_LEFT'; userId: string }
  | { type: 'MULTIPLAYER_PLAYER_READY'; userId: string; ready: boolean }
  | { type: 'MULTIPLAYER_GAME_START' }
  | { type: 'MULTIPLAYER_GAME_OVER'; winner?: string; scores?: Record<string, number> }
  | { type: 'MULTIPLAYER_PLAYER_INPUT'; userId: string; input: unknown }
  | { type: 'MULTIPLAYER_HOST_CHANGED'; newHostId: string }
  | { type: 'MULTIPLAYER_CHAT'; userId?: string; username?: string; message: string }
  | { type: 'MULTIPLAYER_ERROR'; code: string; message: string }
  | { type: 'MULTIPLAYER_CONNECT'; gameId: string; roomId?: string }
  | { type: 'MULTIPLAYER_DISCONNECT' }
  | { type: 'MULTIPLAYER_INPUT'; input: unknown }
  | { type: 'MULTIPLAYER_START_GAME' }
  | { type: 'MULTIPLAYER_SET_READY'; ready: boolean }
  | { type: 'MULTIPLAYER_REQUEST_STATE' }
  | { type: 'MULTIPLAYER_SEND_PEER_DATA'; data: unknown }
  | { type: 'MULTIPLAYER_P2P_STATE'; state: 'connected' | 'disconnected' | 'failed'; peerId?: string }
  | { type: 'MULTIPLAYER_PEER_DATA'; data: unknown };

export type SandboxMessage =
  | { type: 'FULLSCREEN_GRANTED' }
  | { type: 'FULLSCREEN_DENIED' }
  | { type: 'FRESH_GRANTED' }
  | { type: 'FRESH_DENIED' }
  | { type: 'SCORE_SUBMITTED'; score: number; label: string }
  | { type: 'DOCUMENT_DATA'; requestId: string; bytes: ArrayBuffer }
  | { type: 'PREVIEW_INIT'; requestId: string }
  | { type: 'EXECUTE_ZIP'; postId: string; zipData: ArrayBuffer }
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

/** Bounded string check for bridge payloads (malformed-state / relay caps). */
function isCappedString(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** Bounded JSON-serializable payload check for peer-data relay. */
function isCappedPayload(value: unknown, maxBytes = 65536): boolean {
  if (value === null || value === undefined) return true;
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && json.length <= maxBytes;
  } catch {
    return false;
  }
}

export function isParentMessage(msg: unknown): msg is ParentMessage {
  if (!isRecord(msg)) return false;

  switch (msg.type) {
    case 'REQUEST_FULLSCREEN':
      return isPreviewFullscreenRequest(msg);
    case 'REQUEST_FRESH':
      return true;
    case 'POST_SCORE':
      return typeof msg.score === 'number' && !Number.isNaN(msg.score) && typeof msg.label === 'string';
    case 'DOCUMENT_READY':
    case 'VIEWER_CLOSE':
    case 'VIEWER_DOWNLOAD':
      return typeof msg.requestId === 'string';
    case 'CAPTURE_READY':
      return typeof msg.ok === 'boolean';
    case 'CAPTURE_FRAME_RESULT':
      return typeof msg.requestId === 'string' && typeof msg.mime === 'string' && msg.data instanceof ArrayBuffer;
    case 'CAPTURE_GIF_RESULT':
      return typeof msg.requestId === 'string' && Array.isArray(msg.frames);
    case 'CAPTURE_ERROR':
      return typeof msg.requestId === 'string' && typeof msg.message === 'string';
    case 'ZIP_PREVIEW_READY':
    case 'ZIP_READY':
    case 'ZIP_ERROR':
      return isParentZipPreviewMessage(msg);
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
    case 'MULTIPLAYER_HOST_CHANGED':
      return true;
    case 'MULTIPLAYER_PLAYER_INPUT':
      // Unbounded peer input relayed into game state: cap the payload, but
      // keep the old shape-agnostic acceptance otherwise.
      return msg.input === undefined || isCappedPayload(msg.input);
    case 'MULTIPLAYER_CONNECT':
      return isCappedString(msg.gameId, 128) && (msg.roomId === undefined || isCappedString(msg.roomId, 128));
    case 'MULTIPLAYER_DISCONNECT':
    case 'MULTIPLAYER_START_GAME':
    case 'MULTIPLAYER_REQUEST_STATE':
      return true;
    case 'MULTIPLAYER_SET_READY':
      return typeof msg.ready === 'boolean';
    case 'MULTIPLAYER_INPUT':
      return msg.input === undefined || isCappedPayload(msg.input);
    case 'MULTIPLAYER_CHAT':
      return (
        (msg.message === undefined || isCappedString(msg.message, 500)) &&
        (msg.username === undefined || isCappedString(msg.username, 128)) &&
        (msg.userId === undefined || isCappedString(msg.userId, 128))
      );
    case 'MULTIPLAYER_SEND_PEER_DATA':
      return msg.data === undefined || isCappedPayload(msg.data);
    case 'MULTIPLAYER_ERROR':
      return msg.message === undefined || isCappedString(msg.message, 500);
    case 'MULTIPLAYER_P2P_STATE':
      return msg.state === undefined || (typeof msg.state === 'string' && msg.state.length <= 64);
    case 'MULTIPLAYER_PEER_DATA':
      return msg.data === undefined || isCappedPayload(msg.data);
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
    case 'DOCUMENT_DATA':
      return typeof msg.requestId === 'string' && msg.bytes instanceof ArrayBuffer;
    case 'PREVIEW_INIT':
    case 'EXECUTE_ZIP':
      return isSandboxZipPreviewMessage(msg);
    case 'CAPTURE_INIT':
      return true;
    case 'CAPTURE_FRAME':
    case 'CAPTURE_GIF':
      return typeof msg.requestId === 'string';
    case 'MULTIPLAYER_CONNECT':
      return isCappedString(msg.gameId, 128) && (msg.roomId === undefined || isCappedString(msg.roomId, 128));
    case 'MULTIPLAYER_DISCONNECT':
    case 'MULTIPLAYER_START_GAME':
    case 'MULTIPLAYER_REQUEST_STATE':
      return true;
    case 'MULTIPLAYER_SET_READY':
      return typeof msg.ready === 'boolean';
    case 'MULTIPLAYER_INPUT':
      return msg.input === undefined || isCappedPayload(msg.input);
    case 'MULTIPLAYER_CHAT':
      return msg.message === undefined || isCappedString(msg.message, 500);
    case 'MULTIPLAYER_SEND_PEER_DATA':
      return msg.data === undefined || isCappedPayload(msg.data);
    default:
      return false;
  }
}
