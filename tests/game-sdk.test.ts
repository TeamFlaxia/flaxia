import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import type { ScoreSubmittedEvent } from '../packages/game-sdk/src/index.ts';

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

/** Deliver a frame to every registered listener, as the browser would. */
function dispatch(mockWindow: MockWindow, data: unknown, origin = 'https://flaxia.app'): void {
  for (const handler of [...mockWindow.messageHandlers]) {
    handler({ data, origin });
  }
}

describe('FlaxiaGame', () => {
  let mockWindow: MockWindow;
  let sdk: typeof import('../packages/game-sdk/src/index.ts');
  let game: InstanceType<typeof sdk.FlaxiaGame>;

  beforeEach(async () => {
    mockWindow = createMockWindow();
    (globalThis as Record<string, unknown>).window = mockWindow as unknown as Window & typeof globalThis;
    sdk = await import('../packages/game-sdk/src/index.ts');
  });

  describe('constructor', () => {
    it('rejects a missing gameId', () => {
      assert.throws(() => new sdk.FlaxiaGame({ gameId: '' }), /gameId is required/);
    });

    it('auto-connects the bundled multiplayer client by default', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1' });
      const types = mockWindow.postedMessages.map((p) => (p.msg as Record<string, unknown>).type);
      assert.ok(types.includes('MULTIPLAYER_CONNECT'));
    });

    it('respects autoConnect: false', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      assert.equal(mockWindow.postedMessages.length, 0);
    });
  });

  describe('platform capabilities', () => {
    it('requestFullscreen() posts REQUEST_FULLSCREEN to the parent origin', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      mockWindow.postedMessages.length = 0;
      game.requestFullscreen();
      assert.equal(mockWindow.postedMessages.length, 1);
      const posted = mockWindow.postedMessages[0];
      assert.deepEqual(posted.msg, { type: 'REQUEST_FULLSCREEN' });
      assert.equal(posted.origin, 'https://flaxia.app');
    });

    it('requestFresh() posts REQUEST_FRESH', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      mockWindow.postedMessages.length = 0;
      game.requestFresh();
      assert.deepEqual(mockWindow.postedMessages[0].msg, { type: 'REQUEST_FRESH' });
    });

    it('submitScore() posts POST_SCORE with the label', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      mockWindow.postedMessages.length = 0;
      game.submitScore(1234, 'Stage 1 clear');
      assert.deepEqual(mockWindow.postedMessages[0].msg, {
        type: 'POST_SCORE',
        score: 1234,
        label: 'Stage 1 clear',
      });
    });

    it('submitScore() drops non-finite scores', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      mockWindow.postedMessages.length = 0;
      game.submitScore(Number.NaN);
      game.submitScore(Number.POSITIVE_INFINITY);
      assert.equal(mockWindow.postedMessages.length, 0);
    });

    it('sendMessage() drops frames that fail validation', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      mockWindow.postedMessages.length = 0;
      game.sendMessage({ type: 'POST_SCORE', score: Number.NaN, label: '' });
      assert.equal(mockWindow.postedMessages.length, 0);
      game.sendMessage({ type: 'REQUEST_FRESH' });
      assert.equal(mockWindow.postedMessages.length, 1);
    });
  });

  describe('platform events', () => {
    it('fires fullscreen(true/false) for FULLSCREEN_GRANTED/DENIED', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      const seen: boolean[] = [];
      game.on('fullscreen', (granted) => seen.push(granted));

      dispatch(mockWindow, { type: 'FULLSCREEN_GRANTED' });
      dispatch(mockWindow, { type: 'FULLSCREEN_DENIED' });
      assert.deepEqual(seen, [true, false]);
    });

    it('fires fresh(true/false) for FRESH_GRANTED/DENIED', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      const seen: boolean[] = [];
      game.on('fresh', (granted) => seen.push(granted));

      dispatch(mockWindow, { type: 'FRESH_GRANTED' });
      dispatch(mockWindow, { type: 'FRESH_DENIED' });
      assert.deepEqual(seen, [true, false]);
    });

    it('fires scoreSubmitted for SCORE_SUBMITTED', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      let event: ScoreSubmittedEvent | null = null;
      game.on('scoreSubmitted', (e) => {
        event = e;
      });

      dispatch(mockWindow, { type: 'SCORE_SUBMITTED', score: 42, label: 'Clear' });
      assert.deepEqual(event, { score: 42, label: 'Clear' });
    });

    it('fires message for every validated parent frame', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      const seen: string[] = [];
      game.on('message', (message) => seen.push(message.type));

      dispatch(mockWindow, { type: 'FULLSCREEN_GRANTED' });
      dispatch(mockWindow, { type: 'MULTIPLAYER_GAME_START' });
      assert.deepEqual(seen, ['FULLSCREEN_GRANTED', 'MULTIPLAYER_GAME_START']);
    });

    it('ignores frames from a disallowed origin', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      let called = false;
      game.on('message', () => {
        called = true;
      });

      dispatch(mockWindow, { type: 'FULLSCREEN_GRANTED' }, 'https://evil.example');
      assert.equal(called, false);
    });

    it('ignores frames that fail validation', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      let called = false;
      game.on('message', () => {
        called = true;
      });

      dispatch(mockWindow, { type: 'NOT_A_REAL_FRAME' });
      dispatch(mockWindow, { type: 'SCORE_SUBMITTED', score: 'NaN' });
      assert.equal(called, false);
    });
  });

  describe('destroy()', () => {
    it('removes the platform listener and disconnects multiplayer', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: true });
      const listenersBefore = mockWindow.messageHandlers.length;
      assert.ok(listenersBefore >= 2);

      mockWindow.postedMessages.length = 0;
      game.destroy();

      assert.ok(mockWindow.messageHandlers.length < listenersBefore);
      const types = mockWindow.postedMessages.map((p) => (p.msg as Record<string, unknown>).type);
      assert.ok(types.includes('MULTIPLAYER_DISCONNECT'));
    });
  });

  describe('multiplayer delegation', () => {
    it('exposes the bundled MultiplayerClient', () => {
      game = new sdk.FlaxiaGame({ gameId: 'game1', autoConnect: false });
      assert.ok(game.multiplayer instanceof sdk.MultiplayerClient);
      assert.equal(game.isConnected, false);
      assert.equal(game.currentRoomId, null);
    });
  });
});

describe('Game API protocol validators', () => {
  let sdk: typeof import('../packages/game-sdk/src/index.ts');

  beforeEach(async () => {
    sdk = await import('../packages/game-sdk/src/index.ts');
  });

  describe('isParentToGameMessage', () => {
    it('accepts valid frames', () => {
      assert.equal(sdk.isParentToGameMessage({ type: 'FULLSCREEN_GRANTED' }), true);
      assert.equal(sdk.isParentToGameMessage({ type: 'FULLSCREEN_DENIED' }), true);
      assert.equal(sdk.isParentToGameMessage({ type: 'FRESH_GRANTED' }), true);
      assert.equal(sdk.isParentToGameMessage({ type: 'FRESH_DENIED' }), true);
      assert.equal(sdk.isParentToGameMessage({ type: 'SCORE_SUBMITTED', score: 1, label: 'x' }), true);
      assert.equal(sdk.isParentToGameMessage({ type: 'CAPTURE_INIT' }), true);
      assert.equal(sdk.isParentToGameMessage({ type: 'CAPTURE_FRAME', requestId: 'r1' }), true);
      assert.equal(sdk.isParentToGameMessage({ type: 'CAPTURE_GIF', requestId: 'r1' }), true);
      assert.equal(sdk.isParentToGameMessage({ type: 'MULTIPLAYER_GAME_START' }), true);
      assert.equal(
        sdk.isParentToGameMessage({ type: 'MULTIPLAYER_ROOM_STATE', room: { roomId: 'r1' }, players: [] }),
        true,
      );
    });

    it('rejects invalid frames', () => {
      assert.equal(sdk.isParentToGameMessage(null), false);
      assert.equal(sdk.isParentToGameMessage({}), false);
      assert.equal(sdk.isParentToGameMessage({ type: 'UNKNOWN' }), false);
      assert.equal(sdk.isParentToGameMessage({ type: 'SCORE_SUBMITTED', score: '1', label: 'x' }), false);
      assert.equal(sdk.isParentToGameMessage({ type: 'MULTIPLAYER_SET_READY' }), false);
      assert.equal(sdk.isParentToGameMessage({ type: 'CAPTURE_FRAME' }), false);
      assert.equal(sdk.isParentToGameMessage({ type: 'MULTIPLAYER_CHAT', message: 'x'.repeat(501) }), false);
    });
  });

  describe('isGameToParentMessage', () => {
    it('accepts valid frames', () => {
      assert.equal(sdk.isGameToParentMessage({ type: 'REQUEST_FULLSCREEN' }), true);
      assert.equal(sdk.isGameToParentMessage({ type: 'REQUEST_FRESH' }), true);
      assert.equal(sdk.isGameToParentMessage({ type: 'POST_SCORE', score: 1, label: '' }), true);
      assert.equal(sdk.isGameToParentMessage({ type: 'MULTIPLAYER_DISCONNECT' }), true);
      assert.equal(sdk.isGameToParentMessage({ type: 'MULTIPLAYER_SET_READY', ready: true }), true);
      assert.equal(sdk.isGameToParentMessage({ type: 'CAPTURE_READY', ok: true }), true);
    });

    it('rejects invalid frames', () => {
      assert.equal(sdk.isGameToParentMessage(null), false);
      assert.equal(sdk.isGameToParentMessage({ type: 'FULLSCREEN_GRANTED' }), false);
      assert.equal(sdk.isGameToParentMessage({ type: 'POST_SCORE', score: Number.NaN, label: '' }), false);
      assert.equal(sdk.isGameToParentMessage({ type: 'MULTIPLAYER_SET_READY', ready: 'yes' }), false);
      assert.equal(sdk.isGameToParentMessage({ type: 'CAPTURE_READY' }), false);
    });
  });
});
