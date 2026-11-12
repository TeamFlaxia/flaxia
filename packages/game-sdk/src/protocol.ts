/**
 * Flaxia Game API — wire protocol.
 *
 * A game runs inside a sandboxed, opaque-origin iframe on `sandbox.flaxia.app`.
 * It cannot touch the network, cookies, storage or DOM of the main origin, so
 * every platform capability is reached through typed `postMessage` frames to
 * the parent window. This module is the game-side half of that contract; the
 * parent-side half lives in `src/lib/bridge.ts` and the two must stay in sync
 * (enforced by `tests/game-sdk-protocol-sync.test.ts`).
 *
 * The transport is intentionally tiny: the game never opens a WebSocket or a
 * WebRTC peer connection itself. The parent relays control traffic to the
 * Durable Object and game data over P2P, so a game only ever speaks frames.
 */

import type { PlayerInfo, RoomInfo } from './multiplayer/types.ts';

export type { PlayerInfo, RoomInfo };

/** A single raw frame returned by the capture bridge's GIF export. */
export interface CaptureFrame {
  width: number;
  height: number;
  ts: number;
  data: ArrayBuffer;
}

/** Default parent origins the SDK is allowed to exchange frames with. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['https://flaxia.app', 'https://*.flaxia.app'];

/** Maximum size of a JSON-serializable payload the parent will relay. */
export const MAX_PAYLOAD_BYTES = 65_536;

/** Maximum length of a chat message. */
export const MAX_CHAT_LENGTH = 500;

/** Maximum length of a game/room identifier. */
export const MAX_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCappedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isCappedPayload(value: unknown, maxBytes = MAX_PAYLOAD_BYTES): boolean {
  if (value === null || value === undefined) return true;
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && json.length <= maxBytes;
  } catch {
    return false;
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

/**
 * Frames the game may send to the parent. This is the game-facing subset of
 * the parent's `ParentMessage` union: platform requests plus multiplayer and
 * capture replies. ZIP preview and viewer frames are handled by the trusted
 * preview shell, never by game code.
 */
export type GameToParentMessage =
  | { type: 'REQUEST_FULLSCREEN' }
  | { type: 'REQUEST_FRESH' }
  | { type: 'POST_SCORE'; score: number; label: string }
  | { type: 'MULTIPLAYER_CONNECT'; gameId: string; roomId?: string }
  | { type: 'MULTIPLAYER_DISCONNECT' }
  | { type: 'MULTIPLAYER_INPUT'; input: unknown }
  | { type: 'MULTIPLAYER_START_GAME' }
  | { type: 'MULTIPLAYER_SET_READY'; ready: boolean }
  | { type: 'MULTIPLAYER_CHAT'; message?: string; userId?: string; username?: string }
  | { type: 'MULTIPLAYER_REQUEST_STATE' }
  | { type: 'MULTIPLAYER_SEND_PEER_DATA'; data: unknown }
  | { type: 'CAPTURE_READY'; ok: boolean }
  | { type: 'CAPTURE_FRAME_RESULT'; requestId: string; mime: string; data: ArrayBuffer }
  | { type: 'CAPTURE_GIF_RESULT'; requestId: string; frames: CaptureFrame[] }
  | { type: 'CAPTURE_ERROR'; requestId: string; message: string };

/** Frames the parent may send to the game. Mirrors the parent's `SandboxMessage`. */
export type ParentToGameMessage =
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
  | { type: 'MULTIPLAYER_CHAT'; message?: string }
  | { type: 'MULTIPLAYER_REQUEST_STATE' }
  | { type: 'MULTIPLAYER_SEND_PEER_DATA'; data: unknown }
  | { type: 'MULTIPLAYER_STATE'; gameId: string; state: unknown; timestamp: number }
  | { type: 'MULTIPLAYER_ROOM_STATE'; room: RoomInfo; players: PlayerInfo[] }
  | { type: 'MULTIPLAYER_PLAYER_JOINED'; player: PlayerInfo }
  | { type: 'MULTIPLAYER_PLAYER_LEFT'; userId: string }
  | { type: 'MULTIPLAYER_PLAYER_READY'; userId: string; ready: boolean }
  | { type: 'MULTIPLAYER_GAME_START' }
  | { type: 'MULTIPLAYER_GAME_OVER'; winner?: string; scores?: Record<string, number> }
  | { type: 'MULTIPLAYER_PLAYER_INPUT'; userId: string; input: unknown }
  | { type: 'MULTIPLAYER_HOST_CHANGED'; newHostId: string }
  | { type: 'MULTIPLAYER_ERROR'; code: string; message: string }
  | { type: 'MULTIPLAYER_P2P_STATE'; state: 'connected' | 'disconnected' | 'failed'; peerId?: string }
  | { type: 'MULTIPLAYER_PEER_DATA'; data: unknown };

/** Runtime guard for frames coming from the parent. */
export function isParentToGameMessage(value: unknown): value is ParentToGameMessage {
  if (!isRecord(value)) return false;

  switch (value.type) {
    case 'FULLSCREEN_GRANTED':
    case 'FULLSCREEN_DENIED':
    case 'FRESH_GRANTED':
    case 'FRESH_DENIED':
      return true;
    case 'SCORE_SUBMITTED':
      return isNumber(value.score) && typeof value.label === 'string';
    case 'CAPTURE_INIT':
      return true;
    case 'CAPTURE_FRAME':
    case 'CAPTURE_GIF':
      return typeof value.requestId === 'string';
    case 'MULTIPLAYER_CONNECT':
      return (
        isCappedString(value.gameId, MAX_ID_LENGTH) &&
        (value.roomId === undefined || isCappedString(value.roomId, MAX_ID_LENGTH))
      );
    case 'MULTIPLAYER_DISCONNECT':
    case 'MULTIPLAYER_START_GAME':
    case 'MULTIPLAYER_REQUEST_STATE':
      return true;
    case 'MULTIPLAYER_SET_READY':
      return typeof value.ready === 'boolean';
    case 'MULTIPLAYER_INPUT':
      return value.input === undefined || isCappedPayload(value.input);
    case 'MULTIPLAYER_CHAT':
      return value.message === undefined || isCappedString(value.message, MAX_CHAT_LENGTH);
    case 'MULTIPLAYER_SEND_PEER_DATA':
      return value.data === undefined || isCappedPayload(value.data);
    case 'MULTIPLAYER_STATE':
      return typeof value.gameId === 'string';
    case 'MULTIPLAYER_ROOM_STATE':
      return isRecord(value.room);
    case 'MULTIPLAYER_PLAYER_JOINED':
      return isRecord(value.player);
    case 'MULTIPLAYER_PLAYER_LEFT':
    case 'MULTIPLAYER_PLAYER_READY':
    case 'MULTIPLAYER_GAME_START':
    case 'MULTIPLAYER_GAME_OVER':
    case 'MULTIPLAYER_HOST_CHANGED':
      return true;
    case 'MULTIPLAYER_PLAYER_INPUT':
      return value.input === undefined || isCappedPayload(value.input);
    case 'MULTIPLAYER_ERROR':
      return value.message === undefined || isCappedString(value.message, MAX_CHAT_LENGTH);
    case 'MULTIPLAYER_P2P_STATE':
      return value.state === undefined || (typeof value.state === 'string' && value.state.length <= 64);
    case 'MULTIPLAYER_PEER_DATA':
      return value.data === undefined || isCappedPayload(value.data);
    default:
      return false;
  }
}

/** Runtime guard for frames the game sends to the parent. */
export function isGameToParentMessage(value: unknown): value is GameToParentMessage {
  if (!isRecord(value)) return false;

  switch (value.type) {
    case 'REQUEST_FULLSCREEN':
    case 'REQUEST_FRESH':
      return true;
    case 'POST_SCORE':
      return isNumber(value.score) && typeof value.label === 'string';
    case 'MULTIPLAYER_CONNECT':
      return (
        isCappedString(value.gameId, MAX_ID_LENGTH) &&
        (value.roomId === undefined || isCappedString(value.roomId, MAX_ID_LENGTH))
      );
    case 'MULTIPLAYER_DISCONNECT':
    case 'MULTIPLAYER_START_GAME':
    case 'MULTIPLAYER_REQUEST_STATE':
      return true;
    case 'MULTIPLAYER_SET_READY':
      return typeof value.ready === 'boolean';
    case 'MULTIPLAYER_INPUT':
      return value.input === undefined || isCappedPayload(value.input);
    case 'MULTIPLAYER_CHAT':
      return (
        (value.message === undefined || isCappedString(value.message, MAX_CHAT_LENGTH)) &&
        (value.username === undefined || isCappedString(value.username, 128)) &&
        (value.userId === undefined || isCappedString(value.userId, 128))
      );
    case 'MULTIPLAYER_SEND_PEER_DATA':
      return value.data === undefined || isCappedPayload(value.data);
    case 'CAPTURE_READY':
      return typeof value.ok === 'boolean';
    case 'CAPTURE_FRAME_RESULT':
      return typeof value.requestId === 'string' && typeof value.mime === 'string' && value.data instanceof ArrayBuffer;
    case 'CAPTURE_GIF_RESULT':
      return typeof value.requestId === 'string' && Array.isArray(value.frames);
    case 'CAPTURE_ERROR':
      return typeof value.requestId === 'string' && typeof value.message === 'string';
    default:
      return false;
  }
}
