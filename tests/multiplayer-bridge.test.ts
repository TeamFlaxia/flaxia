import assert from 'node:assert';
import { describe, it } from 'node:test';
import { isParentMessage, isSandboxMessage } from '../src/lib/bridge.ts';

describe('isParentMessage', () => {
  it('accepts REQUEST_FULLSCREEN', () => {
    assert.ok(isParentMessage({ type: 'REQUEST_FULLSCREEN' }));
  });

  it('accepts REQUEST_FRESH', () => {
    assert.ok(isParentMessage({ type: 'REQUEST_FRESH' }));
  });

  it('accepts POST_SCORE with valid score', () => {
    assert.ok(isParentMessage({ type: 'POST_SCORE', score: 100, label: 'test' }));
  });

  it('rejects POST_SCORE with NaN score', () => {
    assert.ok(!isParentMessage({ type: 'POST_SCORE', score: NaN, label: 'test' }));
  });

  it('rejects POST_SCORE with non-number score', () => {
    assert.ok(!isParentMessage({ type: 'POST_SCORE', score: 'abc', label: 'test' }));
  });

  it('rejects POST_SCORE with missing label', () => {
    assert.ok(!isParentMessage({ type: 'POST_SCORE', score: 100 }));
  });

  // MULTIPLAYER_STATE
  it('accepts MULTIPLAYER_STATE with gameId', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_STATE', gameId: 'game1', state: {}, timestamp: 1000 }));
  });

  it('rejects MULTIPLAYER_STATE without gameId', () => {
    assert.ok(!isParentMessage({ type: 'MULTIPLAYER_STATE', state: {}, timestamp: 1000 }));
  });

  it('rejects MULTIPLAYER_STATE with non-string gameId', () => {
    assert.ok(!isParentMessage({ type: 'MULTIPLAYER_STATE', gameId: 123, state: {}, timestamp: 1000 }));
  });

  // MULTIPLAYER_ROOM_STATE
  it('accepts MULTIPLAYER_ROOM_STATE with room object', () => {
    assert.ok(
      isParentMessage({
        type: 'MULTIPLAYER_ROOM_STATE',
        room: {
          roomId: 'r1',
          gameId: 'g1',
          hostId: 'h1',
          status: 'lobby',
          maxPlayers: 2,
          isPublic: true,
          createdAt: 0,
        },
        players: [],
      }),
    );
  });

  it('rejects MULTIPLAYER_ROOM_STATE without room object', () => {
    assert.ok(!isParentMessage({ type: 'MULTIPLAYER_ROOM_STATE', players: [] }));
  });

  // MULTIPLAYER_PLAYER_JOINED
  it('accepts MULTIPLAYER_PLAYER_JOINED with player object', () => {
    assert.ok(
      isParentMessage({
        type: 'MULTIPLAYER_PLAYER_JOINED',
        player: { userId: 'u1', username: 'test', displayName: null, avatarKey: null, isReady: false, isHost: false },
      }),
    );
  });

  it('rejects MULTIPLAYER_PLAYER_JOINED without player object', () => {
    assert.ok(!isParentMessage({ type: 'MULTIPLAYER_PLAYER_JOINED' }));
  });

  // MULTIPLAYER_PLAYER_LEFT
  it('accepts MULTIPLAYER_PLAYER_LEFT', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_PLAYER_LEFT', userId: 'u1' }));
  });

  // MULTIPLAYER_PLAYER_READY
  it('accepts MULTIPLAYER_PLAYER_READY', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_PLAYER_READY', userId: 'u1', ready: true }));
  });

  // MULTIPLAYER_GAME_START
  it('accepts MULTIPLAYER_GAME_START', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_GAME_START' }));
  });

  // MULTIPLAYER_GAME_OVER
  it('accepts MULTIPLAYER_GAME_OVER with winner', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_GAME_OVER', winner: 'u1' }));
  });

  it('accepts MULTIPLAYER_GAME_OVER with scores', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_GAME_OVER', scores: { u1: 100, u2: 50 } }));
  });

  it('accepts MULTIPLAYER_GAME_OVER without fields', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_GAME_OVER' }));
  });

  // MULTIPLAYER_PLAYER_INPUT
  it('accepts MULTIPLAYER_PLAYER_INPUT', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_PLAYER_INPUT', userId: 'u1', input: { key: 'a' } }));
  });

  // MULTIPLAYER_HOST_CHANGED
  it('accepts MULTIPLAYER_HOST_CHANGED', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_HOST_CHANGED', newHostId: 'u2' }));
  });

  // MULTIPLAYER_CHAT
  it('accepts MULTIPLAYER_CHAT', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_CHAT', userId: 'u1', username: 'test', message: 'hello' }));
  });

  // MULTIPLAYER_ERROR
  it('accepts MULTIPLAYER_ERROR', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_ERROR', code: 'ERR', message: 'error' }));
  });

  // Reject invalid types
  it('rejects null', () => {
    assert.ok(!isParentMessage(null));
  });

  it('rejects undefined', () => {
    assert.ok(!isParentMessage(undefined));
  });

  it('rejects non-object', () => {
    assert.ok(!isParentMessage('string'));
    assert.ok(!isParentMessage(42));
    assert.ok(!isParentMessage(true));
  });

  it('rejects empty object', () => {
    assert.ok(!isParentMessage({}));
  });

  it('rejects unknown type string', () => {
    assert.ok(!isParentMessage({ type: 'UNKNOWN_TYPE' }));
  });
});

describe('isSandboxMessage', () => {
  // Existing messages
  it('accepts FULLSCREEN_GRANTED', () => {
    assert.ok(isSandboxMessage({ type: 'FULLSCREEN_GRANTED' }));
  });

  it('accepts FULLSCREEN_DENIED', () => {
    assert.ok(isSandboxMessage({ type: 'FULLSCREEN_DENIED' }));
  });

  it('accepts FRESH_GRANTED', () => {
    assert.ok(isSandboxMessage({ type: 'FRESH_GRANTED' }));
  });

  it('accepts FRESH_DENIED', () => {
    assert.ok(isSandboxMessage({ type: 'FRESH_DENIED' }));
  });

  it('accepts SCORE_SUBMITTED with valid score', () => {
    assert.ok(isSandboxMessage({ type: 'SCORE_SUBMITTED', score: 100, label: 'test' }));
  });

  it('rejects SCORE_SUBMITTED with NaN', () => {
    assert.ok(!isSandboxMessage({ type: 'SCORE_SUBMITTED', score: NaN, label: 'test' }));
  });

  // MULTIPLAYER_CONNECT
  it('accepts MULTIPLAYER_CONNECT with gameId', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_CONNECT', gameId: 'game1' }));
  });

  it('accepts MULTIPLAYER_CONNECT with roomId', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_CONNECT', gameId: 'game1', roomId: 'room1' }));
  });

  it('rejects MULTIPLAYER_CONNECT without gameId', () => {
    assert.ok(!isSandboxMessage({ type: 'MULTIPLAYER_CONNECT' }));
  });

  it('rejects MULTIPLAYER_CONNECT with non-string gameId', () => {
    assert.ok(!isSandboxMessage({ type: 'MULTIPLAYER_CONNECT', gameId: 123 }));
  });

  // MULTIPLAYER_DISCONNECT
  it('accepts MULTIPLAYER_DISCONNECT', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_DISCONNECT' }));
  });

  // MULTIPLAYER_INPUT
  it('accepts MULTIPLAYER_INPUT', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_INPUT', input: { key: 'a' }, timestamp: 1000 }));
  });

  // MULTIPLAYER_START_GAME
  it('accepts MULTIPLAYER_START_GAME', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_START_GAME' }));
  });

  // MULTIPLAYER_SET_READY
  it('accepts MULTIPLAYER_SET_READY', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_SET_READY', ready: true }));
  });

  // MULTIPLAYER_CHAT
  it('accepts MULTIPLAYER_CHAT', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_CHAT', message: 'hello' }));
  });

  // MULTIPLAYER_REQUEST_STATE
  it('accepts MULTIPLAYER_REQUEST_STATE', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_REQUEST_STATE' }));
  });

  // Reject invalid
  it('rejects null', () => {
    assert.ok(!isSandboxMessage(null));
  });

  it('rejects non-object', () => {
    assert.ok(!isSandboxMessage(42));
  });

  it('rejects unknown type', () => {
    assert.ok(!isSandboxMessage({ type: 'INVALID' }));
  });

  it('accepts MULTIPLAYER_SEND_PEER_DATA', () => {
    assert.ok(isSandboxMessage({ type: 'MULTIPLAYER_SEND_PEER_DATA', data: { key: 'val' } }));
  });
});

describe('isParentMessage (P2P types)', () => {
  it('accepts MULTIPLAYER_P2P_STATE connected', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_P2P_STATE', state: 'connected' }));
  });

  it('accepts MULTIPLAYER_P2P_STATE disconnected', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_P2P_STATE', state: 'disconnected' }));
  });

  it('accepts MULTIPLAYER_P2P_STATE failed', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_P2P_STATE', state: 'failed', peerId: 'u2' }));
  });

  it('accepts MULTIPLAYER_PEER_DATA', () => {
    assert.ok(isParentMessage({ type: 'MULTIPLAYER_PEER_DATA', data: { score: 100 } }));
  });
});
