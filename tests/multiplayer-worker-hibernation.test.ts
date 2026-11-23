import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';

// The Durable Object is allowed to evict its in-memory instance while keeping
// WebSockets open. This suite simulates that eviction: a second class instance
// sharing the same DurableObjectState must recover the host from socket
// attachments, otherwise the guest sees an empty room and online play stalls.

class FakeSocket {
  sent: string[] = [];
  attachment: unknown = null;
  readyState = 1;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

class FakeState {
  sockets: FakeSocket[] = [];
  blocked: Promise<void> = Promise.resolve();
  pending: Promise<unknown>[] = [];
  private store = new Map<string, unknown>();

  storage = {
    get: async (key: string) => this.store.get(key),
    put: async (key: string, value: unknown) => {
      this.store.set(key, value);
    },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };

  blockConcurrencyWhile(fn: () => Promise<void>): Promise<void> {
    this.blocked = fn();
    return this.blocked;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  acceptWebSocket(ws: FakeSocket): void {
    this.sockets.push(ws);
  }

  getWebSockets(): FakeSocket[] {
    return this.sockets;
  }
}

class FakeResponse {
  status: number;
  webSocket: unknown;
  body: unknown;

  constructor(body: unknown, init: { status?: number; webSocket?: unknown } = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
  }
}

type WorkerModule = typeof import('../multiplayer-worker/src/index.ts');

let MultiplayerRoom: WorkerModule['MultiplayerRoom'];
const originalResponse = globalThis.Response;
const originalWebSocketPair = (globalThis as Record<string, unknown>)['WebSocketPair'];

before(async () => {
  globalThis.Response = FakeResponse as unknown as typeof Response;
  (globalThis as Record<string, unknown>)['WebSocketPair'] = class {
    [index: number]: FakeSocket;
    constructor() {
      this[0] = new FakeSocket();
      this[1] = new FakeSocket();
    }
  };
  ({ MultiplayerRoom } = await import('../multiplayer-worker/src/index.ts'));
});

after(() => {
  globalThis.Response = originalResponse;
  (globalThis as Record<string, unknown>)['WebSocketPair'] = originalWebSocketPair;
});

function socketUrl(params: Record<string, string>): URL {
  const url = new URL('https://internal/');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function messages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

describe('MultiplayerRoom hibernation', () => {
  it('restores the host from socket attachments after eviction', async () => {
    const state = new FakeState();
    const hostParams = {
      userId: 'host-1',
      username: 'host',
      gameId: 'game-1',
      roomId: 'room-1',
      maxPlayers: '2',
      hostId: 'host-1',
    };

    const first = new MultiplayerRoom(state as never);
    await state.blocked;
    await (
      first as unknown as { handleWebSocketUpgrade: (r: Request, u: URL) => Promise<unknown> }
    ).handleWebSocketUpgrade(new Request('https://internal/'), socketUrl(hostParams));
    await Promise.all(state.pending);
    assert.equal(state.sockets.length, 1);
    const hostSocket = state.sockets[0];

    // New instance, same DurableObjectState: exactly what hibernation does.
    const second = new MultiplayerRoom(state as never);
    await state.blocked;
    await (
      second as unknown as { handleWebSocketUpgrade: (r: Request, u: URL) => Promise<unknown> }
    ).handleWebSocketUpgrade(
      new Request('https://internal/'),
      socketUrl({ ...hostParams, userId: 'guest-1', username: 'guest' }),
    );
    await Promise.all(state.pending);

    assert.equal(state.sockets.length, 2);
    const guestSocket = state.sockets[1];
    const guestState = messages(guestSocket).find((message) => message.type === 'room_state');
    assert.ok(guestState, 'guest did not receive room_state');
    assert.equal((guestState.players as unknown[]).length, 2);
    assert.deepEqual((guestState.players as Array<{ userId: string }>).map((player) => player.userId).sort(), [
      'guest-1',
      'host-1',
    ]);

    const joined = messages(hostSocket).find((message) => message.type === 'player_joined');
    assert.ok(joined, 'host did not receive player_joined after eviction');
    assert.equal((joined.player as { userId: string }).userId, 'guest-1');

    // The host's lobby count comes from room_state, not player_joined.
    const hostState = messages(hostSocket).find(
      (message) => message.type === 'room_state' && (message.players as unknown[]).length === 2,
    );
    assert.ok(hostState, 'host did not receive a two-player room_state');
  });

  it('does not resurrect a player who leaves while the socket stays open', async () => {
    const state = new FakeState();
    const params = {
      userId: 'host-1',
      username: 'host',
      gameId: 'game-1',
      roomId: 'room-1',
      maxPlayers: '2',
      hostId: 'host-1',
    };
    const room = new MultiplayerRoom(state as never);
    await state.blocked;
    await (
      room as unknown as { handleWebSocketUpgrade: (r: Request, u: URL) => Promise<unknown> }
    ).handleWebSocketUpgrade(new Request('https://internal/'), socketUrl(params));
    await (
      room as unknown as { handleWebSocketUpgrade: (r: Request, u: URL) => Promise<unknown> }
    ).handleWebSocketUpgrade(
      new Request('https://internal/'),
      socketUrl({ ...params, userId: 'guest-1', username: 'guest' }),
    );
    await Promise.all(state.pending);
    assert.equal(state.sockets.length, 2);

    const hostSocket = state.sockets[0];
    const leave = JSON.stringify({ type: 'leave' });
    await (room as unknown as { webSocketMessage: (ws: WebSocket, message: string) => Promise<void> }).webSocketMessage(
      hostSocket as never,
      leave,
    );
    assert.equal(hostSocket.readyState, 3, 'the leaving socket must be closed');

    // Simulate hibernation: a fresh instance must not rebuild the host from
    // the still-open socket's attachment.
    const evicted = new MultiplayerRoom(state as never);
    await state.blocked;
    const response = await (evicted as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
      new Request('https://internal/'),
    );
    const body = JSON.parse(String((response as unknown as { body: unknown }).body)) as {
      playerCount: number;
      players: Array<{ userId: string }>;
    };
    assert.equal(body.playerCount, 1);
    assert.deepEqual(
      body.players.map((player) => player.userId),
      ['guest-1'],
    );
  });
});
