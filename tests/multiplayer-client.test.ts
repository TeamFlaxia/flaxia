import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

type MessageHandler = (event: { data: unknown; origin: string }) => void;

interface MockWindow {
  addEventListener: (type: string, handler: MessageHandler) => void;
  removeEventListener: (type: string, handler: MessageHandler) => void;
  parent: { postMessage: (msg: unknown, origin: string) => void };
  postedMessages: Array<{ msg: unknown; origin: string }>;
  messageHandlers: MessageHandler[];
}

function createMockWindow(): MockWindow {
  const handlers: MessageHandler[] = [];
  const posted: Array<{ msg: unknown; origin: string }> = [];
  return {
    addEventListener: (_type: string, handler: MessageHandler) => {
      handlers.push(handler);
    },
    removeEventListener: (_type: string, handler: MessageHandler) => {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    },
    parent: {
      postMessage: (msg: unknown, origin: string) => {
        posted.push({ msg, origin });
      },
    },
    postedMessages: posted,
    messageHandlers: handlers,
  };
}

describe('MultiplayerClient', () => {
  let mockWindow: MockWindow;
  let FlaxiaMultiplayer: typeof import('../packages/multiplayer/src/index');
  let client: InstanceType<typeof FlaxiaMultiplayer.MultiplayerClient>;

  beforeEach(async () => {
    mockWindow = createMockWindow();
    (globalThis as Record<string, unknown>).window = mockWindow as unknown as Window & typeof globalThis;
    FlaxiaMultiplayer = await import('../packages/multiplayer/src/index.ts');
  });

  describe('connect()', () => {
    it('sends MULTIPLAYER_CONNECT on connect', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      assert.equal(mockWindow.postedMessages.length, 1);
      const msg = mockWindow.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_CONNECT');
      assert.equal(msg.gameId, 'game1');
    });

    it('does not double-connect', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.connect();
      assert.equal(mockWindow.postedMessages.length, 1);
    });

    it('accepts optional roomId', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', roomId: 'room1', autoConnect: true });
      const msg = mockWindow.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.roomId, 'room1');
    });

    it('respects autoConnect: false', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: false });
      assert.equal(mockWindow.postedMessages.length, 0);
      client.connect('room2');
      const msg = mockWindow.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_CONNECT');
      assert.equal(msg.roomId, 'room2');
    });

    it('registers a message listener', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      assert.equal(mockWindow.messageHandlers.length, 1);
    });
  });

  describe('disconnect()', () => {
    it('sends MULTIPLAYER_DISCONNECT', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      mockWindow.postedMessages.length = 0;
      client.disconnect();
      const msg = mockWindow.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_DISCONNECT');
    });

    it('removes message listener', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.disconnect();
      assert.equal(mockWindow.messageHandlers.length, 0);
    });

    it('isConnected returns false after disconnect', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      assert.ok(client.isConnected);
      client.disconnect();
      assert.ok(!client.isConnected);
    });

    it('fires onDisconnect callback', () => {
      let called = false;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onDisconnect', () => {
        called = true;
      });
      client.disconnect();
      assert.ok(called);
    });
  });

  describe('sendInput()', () => {
    it('sends MULTIPLAYER_INPUT with input data and timestamp', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      mockWindow.postedMessages.length = 0;
      client.sendInput({ key: 'ArrowLeft', held: true });
      assert.equal(mockWindow.postedMessages.length, 1);
      const msg = mockWindow.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_INPUT');
      assert.deepStrictEqual(msg.input, { key: 'ArrowLeft', held: true });
      assert.ok(typeof msg.timestamp === 'number');
    });

    it('does nothing when not connected', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: false });
      client.sendInput({ key: 'x' });
      assert.equal(mockWindow.postedMessages.length, 0);
    });
  });

  describe('startGame()', () => {
    it('sends MULTIPLAYER_START_GAME', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      mockWindow.postedMessages.length = 0;
      client.startGame();
      assert.equal(mockWindow.postedMessages[0].msg.type, 'MULTIPLAYER_START_GAME');
    });
  });

  describe('setReady()', () => {
    it('sends MULTIPLAYER_SET_READY with ready state', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      mockWindow.postedMessages.length = 0;
      client.setReady(true);
      const msg = mockWindow.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_SET_READY');
      assert.equal(msg.ready, true);

      mockWindow.postedMessages.length = 0;
      client.setReady(false);
      assert.equal((mockWindow.postedMessages[0].msg as Record<string, unknown>).ready, false);
    });
  });

  describe('sendChat()', () => {
    it('sends MULTIPLAYER_CHAT with message', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      mockWindow.postedMessages.length = 0;
      client.sendChat('hello');
      const msg = mockWindow.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_CHAT');
      assert.equal(msg.message, 'hello');
    });
  });

  describe('requestState()', () => {
    it('sends MULTIPLAYER_REQUEST_STATE', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      mockWindow.postedMessages.length = 0;
      client.requestState();
      assert.equal(mockWindow.postedMessages[0].msg.type, 'MULTIPLAYER_REQUEST_STATE');
    });
  });

  describe('event handlers', () => {
    it('fires onRoomState on MULTIPLAYER_ROOM_STATE message', () => {
      let state: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onRoomState', (s) => {
        state = s;
      });

      const roomPayload = {
        type: 'MULTIPLAYER_ROOM_STATE',
        room: {
          roomId: 'r1',
          gameId: 'g1',
          hostId: 'u1',
          status: 'lobby',
          maxPlayers: 2,
          isPublic: true,
          createdAt: 0,
        },
        players: [{ userId: 'u1', username: 'test', displayName: null, avatarKey: null, isReady: false, isHost: true }],
      };
      mockWindow.messageHandlers[0]({ data: roomPayload, origin: 'https://flaxia.app' });

      assert.ok(state !== null);
      const s = state as Record<string, unknown>;
      assert.equal((s.room as Record<string, unknown>).roomId, 'r1');
    });

    it('fires onPlayerJoined on MULTIPLAYER_PLAYER_JOINED', () => {
      let player: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onPlayerJoined', (p) => {
        player = p;
      });

      mockWindow.messageHandlers[0]({
        data: {
          type: 'MULTIPLAYER_PLAYER_JOINED',
          player: { userId: 'u2', username: 'p2', displayName: null, avatarKey: null, isReady: false, isHost: false },
        },
        origin: 'https://flaxia.app',
      });

      assert.equal((player as Record<string, unknown>).userId, 'u2');
    });

    it('fires onPlayerLeft on MULTIPLAYER_PLAYER_LEFT', () => {
      let userId: string | null = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onPlayerLeft', (id) => {
        userId = id;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_PLAYER_LEFT', userId: 'u2' },
        origin: 'https://flaxia.app',
      });
      assert.equal(userId, 'u2');
    });

    it('fires onPlayerReady on MULTIPLAYER_PLAYER_READY', () => {
      let args: { userId: string; ready: boolean } | null = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onPlayerReady', (id, r) => {
        args = { userId: id, ready: r };
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_PLAYER_READY', userId: 'u1', ready: true },
        origin: 'https://flaxia.app',
      });
      assert.equal(args?.userId, 'u1');
      assert.equal(args?.ready, true);
    });

    it('fires onGameStart on MULTIPLAYER_GAME_START', () => {
      let called = false;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onGameStart', () => {
        called = true;
      });

      mockWindow.messageHandlers[0]({ data: { type: 'MULTIPLAYER_GAME_START' }, origin: 'https://flaxia.app' });
      assert.ok(called);
    });

    it('fires onGameState on MULTIPLAYER_STATE', () => {
      let event: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onGameState', (e) => {
        event = e;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_STATE', gameId: 'g1', state: { score: 100 }, timestamp: 500 },
        origin: 'https://flaxia.app',
      });
      const e = event as Record<string, unknown>;
      assert.equal(e.gameId, 'g1');
      assert.deepStrictEqual(e.state, { score: 100 });
    });

    it('fires onPlayerInput on MULTIPLAYER_PLAYER_INPUT', () => {
      let event: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onPlayerInput', (e) => {
        event = e;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_PLAYER_INPUT', userId: 'u2', input: { key: 'a' } },
        origin: 'https://flaxia.app',
      });
      const e = event as Record<string, unknown>;
      assert.equal(e.userId, 'u2');
      assert.deepStrictEqual(e.input, { key: 'a' });
    });

    it('fires onGameOver on MULTIPLAYER_GAME_OVER', () => {
      let event: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onGameOver', (e) => {
        event = e;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_GAME_OVER', winner: 'u1', scores: { u1: 100 } },
        origin: 'https://flaxia.app',
      });
      const e = event as Record<string, unknown>;
      assert.equal(e.winner, 'u1');
      assert.deepStrictEqual(e.scores, { u1: 100 });
    });

    it('fires onHostChanged on MULTIPLAYER_HOST_CHANGED', () => {
      let newHostId: string | null = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onHostChanged', (id) => {
        newHostId = id;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_HOST_CHANGED', newHostId: 'u2' },
        origin: 'https://flaxia.app',
      });
      assert.equal(newHostId, 'u2');
    });

    it('fires onChat on MULTIPLAYER_CHAT', () => {
      let event: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onChat', (e) => {
        event = e;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_CHAT', userId: 'u2', username: 'p2', message: 'hi' },
        origin: 'https://flaxia.app',
      });
      const e = event as Record<string, unknown>;
      assert.equal(e.userId, 'u2');
      assert.equal(e.message, 'hi');
    });

    it('fires onError on MULTIPLAYER_ERROR', () => {
      let error: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onError', (e) => {
        error = e;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_ERROR', code: 'ROOM_FULL', message: 'Room is full' },
        origin: 'https://flaxia.app',
      });
      const e = error as Record<string, unknown>;
      assert.equal(e.code, 'ROOM_FULL');
      assert.equal(e.message, 'Room is full');
    });
  });

  describe('origin validation', () => {
    it('ignores messages from disallowed origins', () => {
      let state: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: true });
      client.on('onRoomState', (s) => {
        state = s;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_ROOM_STATE', room: { roomId: 'r1' }, players: [] },
        origin: 'https://evil.com',
      });
      assert.equal(state, null);
    });

    it('accepts messages from wildcard-matched origins', () => {
      let state: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({
        gameId: 'game1',
        autoConnect: true,
        allowedOrigins: ['https://*.example.com'],
      });
      client.on('onRoomState', (s) => {
        state = s;
      });

      mockWindow.messageHandlers[0]({
        data: {
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
        },
        origin: 'https://sub.example.com',
      });
      assert.ok(state !== null);
    });

    it('rejects messages from origins not matching wildcard', () => {
      let state: unknown = null;
      client = new FlaxiaMultiplayer.MultiplayerClient({
        gameId: 'game1',
        autoConnect: true,
        allowedOrigins: ['https://*.example.com'],
      });
      client.on('onRoomState', (s) => {
        state = s;
      });

      mockWindow.messageHandlers[0]({
        data: { type: 'MULTIPLAYER_ROOM_STATE', room: { roomId: 'r1' }, players: [] },
        origin: 'https://evil.example.org',
      });
      assert.equal(state, null);
    });
  });

  describe('isConnected and currentRoomId', () => {
    it('returns correct connection status', () => {
      client = new FlaxiaMultiplayer.MultiplayerClient({ gameId: 'game1', autoConnect: false });
      assert.ok(!client.isConnected);
      assert.equal(client.currentRoomId, null);

      client.connect();
      assert.ok(client.isConnected);

      mockWindow.messageHandlers[0]({
        data: {
          type: 'MULTIPLAYER_ROOM_STATE',
          room: {
            roomId: 'r1',
            gameId: 'g1',
            hostId: 'u1',
            status: 'lobby',
            maxPlayers: 2,
            isPublic: true,
            createdAt: 0,
          },
          players: [],
        },
        origin: 'https://flaxia.app',
      });
      assert.equal(client.currentRoomId, 'r1');

      client.disconnect();
      assert.ok(!client.isConnected);
    });
  });
});
