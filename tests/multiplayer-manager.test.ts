import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';

interface MockWebSocket extends EventEmitter {
  readyState: number;
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
  sentMessages: string[];
}

interface MockIframe {
  contentWindow: {
    postMessage: (msg: unknown, origin: string) => void;
  } | null;
  postedMessages: Array<{ msg: unknown; origin: string }>;
}

const WS_OPEN = 1;

function createMockWebSocket(): MockWebSocket {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  const ws = emitter as unknown as MockWebSocket;
  ws.readyState = WS_OPEN;
  ws.send = (data: string) => {
    sent.push(data);
  };
  ws.close = (_code: number, _reason: string) => {
    ws.readyState = 0;
    emitter.emit('close');
  };
  ws.sentMessages = sent;
  return ws;
}

function createMockIframe(): MockIframe {
  const posted: Array<{ msg: unknown; origin: string }> = [];
  return {
    contentWindow: {
      postMessage: (msg: unknown, origin: string) => {
        posted.push({ msg, origin });
      },
    },
    postedMessages: posted,
  };
}

describe('MultiplayerManager', () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let mockWs: MockWebSocket;
  let mockIframe: MockIframe;
  let MultiplayerManager: typeof import('../src/lib/multiplayer-manager').MultiplayerManager;
  let manager: InstanceType<typeof MultiplayerManager>;

  beforeEach(async () => {
    mockIframe = createMockIframe();
    mockWs = createMockWebSocket();

    globalThis.RTCPeerConnection = class {
      createDataChannel() {
        return { send() {}, close() {}, onopen: null, onclose: null, onmessage: null, readyState: 'closed' };
      }
      createOffer() {
        return Promise.resolve({ type: 'offer', sdp: '' });
      }
      createAnswer() {
        return Promise.resolve({ type: 'answer', sdp: '' });
      }
      setLocalDescription() {
        return Promise.resolve();
      }
      setRemoteDescription() {
        return Promise.resolve();
      }
      addIceCandidate() {
        return Promise.resolve();
      }
      close() {}
      onicecandidate: ((event: { candidate?: unknown }) => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      ondatachannel: ((event: { channel: unknown }) => void) | null = null;
      iceConnectionState = 'new';
    } as unknown as typeof globalThis.RTCPeerConnection;

    originalWebSocket = globalThis.WebSocket;
    class MockWebSocketClass extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 0;
      readyState = WS_OPEN;
      sentMessages = mockWs.sentMessages;
      constructor(_url: string) {
        super();
        mockWs = this as unknown as MockWebSocket;
        mockWs.sentMessages = [];
        setTimeout(() => this.emit('open'), 0);
      }
      send(data: string) {
        mockWs.sentMessages.push(data);
      }
      close(code?: number, reason?: string) {
        this.readyState = 0;
        this.emit('close');
      }
      addEventListener(type: string, handler: (...args: unknown[]) => void) {
        this.on(type, handler);
      }
    }
    globalThis.WebSocket = MockWebSocketClass as unknown as typeof globalThis.WebSocket;

    globalThis.location = { origin: 'http://localhost:8788' } as unknown as typeof globalThis.location;

    MultiplayerManager = (await import('../src/lib/multiplayer-manager.ts')).MultiplayerManager;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    delete (globalThis as Record<string, unknown>).RTCPeerConnection;
  });

  describe('connect()', () => {
    it('creates a WebSocket connection', () => {
      manager = new MultiplayerManager({
        gameId: 'game1',
        roomId: 'room1',
        userId: 'u1',
        wsUrl: '/api/ws/multiplayer',
        iframe: mockIframe as unknown as HTMLIFrameElement,
        sandboxOrigin: 'https://sandbox.flaxia.app',
      });
      manager.connect();
      assert.ok(mockWs !== undefined);
    });
  });

  describe('disconnect()', () => {
    it('closes WebSocket', () => {
      manager = new MultiplayerManager({
        gameId: 'game1',
        roomId: 'room1',
        userId: 'u1',
        wsUrl: '/api/ws/multiplayer',
        iframe: mockIframe as unknown as HTMLIFrameElement,
        sandboxOrigin: 'https://sandbox.flaxia.app',
      });
      manager.connect();
      manager.disconnect();
      assert.equal(mockWs.readyState, 0);
    });
  });

  describe('handleGameMessage()', () => {
    beforeEach(() => {
      manager = new MultiplayerManager({
        gameId: 'game1',
        roomId: 'room1',
        userId: 'u1',
        wsUrl: '/api/ws/multiplayer',
        iframe: mockIframe as unknown as HTMLIFrameElement,
        sandboxOrigin: 'https://sandbox.flaxia.app',
      });
      manager.connect();
      mockWs.emit('open');
      mockWs.sentMessages.length = 0;
    });

    it('relays MULTIPLAYER_INPUT as input message', () => {
      manager.handleGameMessage({ type: 'MULTIPLAYER_INPUT', input: { key: 'a' } });
      assert.equal(mockWs.sentMessages.length, 1);
      const msg = JSON.parse(mockWs.sentMessages[0]);
      assert.equal(msg.type, 'input');
      assert.deepStrictEqual(msg.input, { key: 'a' });
    });

    it('relays MULTIPLAYER_START_GAME as start_game', () => {
      manager.handleGameMessage({ type: 'MULTIPLAYER_START_GAME' });
      const msg = JSON.parse(mockWs.sentMessages[0]);
      assert.equal(msg.type, 'start_game');
    });

    it('relays MULTIPLAYER_SET_READY as ready', () => {
      manager.handleGameMessage({ type: 'MULTIPLAYER_SET_READY', ready: true });
      const msg = JSON.parse(mockWs.sentMessages[0]);
      assert.equal(msg.type, 'ready');
      assert.equal(msg.ready, true);
    });

    it('relays MULTIPLAYER_CHAT as chat', () => {
      manager.handleGameMessage({ type: 'MULTIPLAYER_CHAT', message: 'hello' });
      const msg = JSON.parse(mockWs.sentMessages[0]);
      assert.equal(msg.type, 'chat');
      assert.equal(msg.message, 'hello');
    });

    it('relays MULTIPLAYER_REQUEST_STATE as request_state', () => {
      manager.handleGameMessage({ type: 'MULTIPLAYER_REQUEST_STATE' });
      const msg = JSON.parse(mockWs.sentMessages[0]);
      assert.equal(msg.type, 'request_state');
    });

    it('handles MULTIPLAYER_DISCONNECT by closing WebSocket', () => {
      manager.handleGameMessage({ type: 'MULTIPLAYER_DISCONNECT' });
      assert.equal(mockWs.readyState, 0);
    });

    it('ignores unknown message types', () => {
      manager.handleGameMessage({ type: 'UNKNOWN' } as Record<string, unknown>);
      assert.equal(mockWs.sentMessages.length, 0);
    });

    it('does not send when WebSocket is not open', () => {
      mockWs.readyState = 0;
      manager.handleGameMessage({ type: 'MULTIPLAYER_INPUT', input: { x: 1 } });
      assert.equal(mockWs.sentMessages.length, 0);
    });
  });

  describe('WebSocket → postMessage relay', () => {
    beforeEach(() => {
      manager = new MultiplayerManager({
        gameId: 'game1',
        roomId: 'room1',
        userId: 'u1',
        wsUrl: '/api/ws/multiplayer',
        iframe: mockIframe as unknown as HTMLIFrameElement,
        sandboxOrigin: 'https://sandbox.flaxia.app',
      });
      manager.connect();
      mockIframe.postedMessages.length = 0;
    });

    function simulateWsMessage(data: Record<string, unknown>): void {
      mockWs.emit('message', { data: JSON.stringify(data) });
    }

    it('relays room_state → MULTIPLAYER_ROOM_STATE', () => {
      simulateWsMessage({ type: 'room_state', room: { roomId: 'r1' }, players: [] });
      assert.equal(mockIframe.postedMessages.length, 1);
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_ROOM_STATE');
      assert.deepStrictEqual(msg.room, { roomId: 'r1' });
    });

    it('relays player_joined → MULTIPLAYER_PLAYER_JOINED', () => {
      simulateWsMessage({ type: 'player_joined', player: { userId: 'u2' } });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_PLAYER_JOINED');
      assert.deepStrictEqual(msg.player, { userId: 'u2' });
    });

    it('relays player_left → MULTIPLAYER_PLAYER_LEFT', () => {
      simulateWsMessage({ type: 'player_left', userId: 'u2' });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_PLAYER_LEFT');
      assert.equal(msg.userId, 'u2');
    });

    it('relays player_ready → MULTIPLAYER_PLAYER_READY', () => {
      simulateWsMessage({ type: 'player_ready', userId: 'u1', ready: true });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_PLAYER_READY');
      assert.equal(msg.userId, 'u1');
      assert.equal(msg.ready, true);
    });

    it('relays game_start → MULTIPLAYER_GAME_START', () => {
      simulateWsMessage({ type: 'game_start' });
      assert.equal((mockIframe.postedMessages[0].msg as Record<string, unknown>).type, 'MULTIPLAYER_GAME_START');
    });

    it('relays game_state → MULTIPLAYER_STATE', () => {
      simulateWsMessage({ type: 'game_state', state: { score: 100 }, timestamp: 500 });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_STATE');
      assert.equal(msg.gameId, 'game1');
      assert.deepStrictEqual(msg.state, { score: 100 });
    });

    it('relays player_input → MULTIPLAYER_PLAYER_INPUT', () => {
      simulateWsMessage({ type: 'player_input', userId: 'u2', input: { key: 'a' } });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_PLAYER_INPUT');
      assert.equal(msg.userId, 'u2');
    });

    it('relays game_over → MULTIPLAYER_GAME_OVER', () => {
      simulateWsMessage({ type: 'game_over', winner: 'u1', scores: { u1: 100 } });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_GAME_OVER');
      assert.equal(msg.winner, 'u1');
    });

    it('relays host_changed → MULTIPLAYER_HOST_CHANGED', () => {
      simulateWsMessage({ type: 'host_changed', newHostId: 'u2' });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_HOST_CHANGED');
      assert.equal(msg.newHostId, 'u2');
    });

    it('relays chat → MULTIPLAYER_CHAT', () => {
      simulateWsMessage({ type: 'chat', userId: 'u2', username: 'p2', message: 'hi' });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_CHAT');
      assert.equal(msg.userId, 'u2');
      assert.equal(msg.message, 'hi');
    });

    it('relays error → MULTIPLAYER_ERROR', () => {
      simulateWsMessage({ type: 'error', code: 'ROOM_FULL', message: 'Room is full' });
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_ERROR');
      assert.equal(msg.code, 'ROOM_FULL');
    });

    it('sends correct targetOrigin on relay', () => {
      simulateWsMessage({ type: 'game_start' });
      assert.equal(mockIframe.postedMessages[0].origin, 'https://sandbox.flaxia.app');
    });
  });

  describe('destroy()', () => {
    it('closes WebSocket on destroy', () => {
      manager = new MultiplayerManager({
        gameId: 'game1',
        roomId: 'room1',
        userId: 'u1',
        wsUrl: '/api/ws/multiplayer',
        iframe: mockIframe as unknown as HTMLIFrameElement,
        sandboxOrigin: 'https://sandbox.flaxia.app',
      });
      manager.connect();
      manager.destroy();
      assert.equal(mockWs.readyState, 0);
    });
  });

  describe('P2P fallback (peer_data via WS)', () => {
    beforeEach(() => {
      manager = new MultiplayerManager({
        gameId: 'game1',
        roomId: 'room1',
        userId: 'u1',
        wsUrl: '/api/ws/multiplayer',
        iframe: mockIframe as unknown as HTMLIFrameElement,
        sandboxOrigin: 'https://sandbox.flaxia.app',
      });
      manager.connect();
      mockWs.emit('open');
      mockWs.sentMessages.length = 0;
    });

    it('sends peer_data via WebSocket when P2P not connected', () => {
      manager.handleGameMessage({ type: 'MULTIPLAYER_SEND_PEER_DATA', data: { hello: 'world' } });
      assert.equal(mockWs.sentMessages.length, 1);
      const msg = JSON.parse(mockWs.sentMessages[0]);
      assert.equal(msg.type, 'peer_data');
      assert.deepStrictEqual(msg.data, { hello: 'world' });
    });

    it('does not send when WS is not open', () => {
      mockWs.readyState = 0;
      manager.handleGameMessage({ type: 'MULTIPLAYER_SEND_PEER_DATA', data: { x: 1 } });
      assert.equal(mockWs.sentMessages.length, 0);
    });
  });

  describe('WebSocket → postMessage relay (P2P types)', () => {
    beforeEach(() => {
      manager = new MultiplayerManager({
        gameId: 'game1',
        roomId: 'room1',
        userId: 'u1',
        wsUrl: '/api/ws/multiplayer',
        iframe: mockIframe as unknown as HTMLIFrameElement,
        sandboxOrigin: 'https://sandbox.flaxia.app',
      });
      manager.connect();
      mockIframe.postedMessages.length = 0;
    });

    it('relays peer_data → MULTIPLAYER_PEER_DATA', () => {
      mockWs.emit('message', { data: JSON.stringify({ type: 'peer_data', data: { score: 100 } }) });
      assert.equal(mockIframe.postedMessages.length, 1);
      const msg = mockIframe.postedMessages[0].msg as Record<string, unknown>;
      assert.equal(msg.type, 'MULTIPLAYER_PEER_DATA');
      assert.deepStrictEqual(msg.data, { score: 100 });
    });

    it('does not relay signal messages to iframe', () => {
      mockWs.emit('message', {
        data: JSON.stringify({ type: 'signal', userId: 'u2', signal: { type: 'offer', payload: {} } }),
      });
      assert.equal(mockIframe.postedMessages.length, 0);
    });
  });
});
