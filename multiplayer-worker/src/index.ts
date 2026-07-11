/// <reference types="@cloudflare/workers-types" />

interface PlayerInfo {
  userId: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
  ws: WebSocket;
  isReady: boolean;
  isHost: boolean;
  connectedAt: number;
}

interface PlayerSummary {
  userId: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
  isReady: boolean;
  isHost: boolean;
}

type RoomStatus = 'lobby' | 'playing' | 'finished';

interface RoomMetadata {
  roomId: string;
  gameId: string;
  hostId: string;
  status: RoomStatus;
  maxPlayers: number;
  isPublic: boolean;
  createdAt: number;
}

type ClientMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'start_game' }
  | { type: 'leave' }
  | { type: 'input'; input: unknown; timestamp: number }
  | { type: 'chat'; message: string }
  | { type: 'request_state' }
  | { type: 'signal'; targetUserId: string; signal: { type: string; payload: unknown } }
  | { type: 'peer_data'; data: unknown };

type ServerMessage =
  | { type: 'room_state'; room: RoomMetadata; players: PlayerSummary[] }
  | { type: 'player_joined'; player: PlayerSummary }
  | { type: 'player_left'; userId: string }
  | { type: 'player_ready'; userId: string; ready: boolean }
  | { type: 'game_start' }
  | { type: 'game_state'; state: unknown; timestamp: number }
  | { type: 'player_input'; userId: string; input: unknown }
  | { type: 'game_over'; winner?: string; scores?: Record<string, number> }
  | { type: 'error'; code: string; message: string }
  | { type: 'chat'; userId: string; username: string; message: string }
  | { type: 'host_changed'; newHostId: string }
  | { type: 'signal'; userId: string; signal: { type: string; payload: unknown } }
  | { type: 'peer_data'; userId: string; data: unknown };

const INACTIVITY_TIMEOUT_MS = 300_000;
const LOBBY_TIMEOUT_MS = 1_800_000;

export class MultiplayerRoom {
  private ctx: DurableObjectState;
  private players: Map<string, PlayerInfo> = new Map();
  private roomId = '';
  private gameId = '';
  private hostId = '';
  private status: RoomStatus = 'lobby';
  private maxPlayers = 2;
  private isPublic = true;
  private createdAt = 0;
  private gameState: unknown = null;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request, url);
    }

    if (request.method === 'POST') {
      return this.handleApiPost(request);
    }

    if (request.method === 'GET') {
      return this.handleApiGet();
    }

    return new Response('MultiplayerRoom DO', { status: 200 });
  }

  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    const userId = url.searchParams.get('userId') || '';
    const username = url.searchParams.get('username') || '';
    const displayName = url.searchParams.get('display_name') || null;
    const avatarKey = url.searchParams.get('avatar_key') || null;
    const gameId = url.searchParams.get('gameId') || '';
    const roomId = url.searchParams.get('roomId') || '';

    if (!userId || !gameId || !roomId) {
      return new Response('Missing required params: userId, gameId, roomId', { status: 400 });
    }

    if (this.players.size >= this.maxPlayers) {
      return new Response('Room is full', { status: 403 });
    }

    if (this.status !== 'lobby') {
      return new Response('Game already in progress', { status: 403 });
    }

    if (this.players.has(userId)) {
      return new Response('Already in this room', { status: 409 });
    }

    if (this.players.size === 0) {
      this.roomId = roomId;
      this.gameId = gameId;
      this.hostId = userId;
      this.createdAt = Date.now();
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server);

    const isHost = this.players.size === 0;
    const info: PlayerInfo = {
      userId,
      username,
      displayName,
      avatarKey,
      ws: server,
      isReady: false,
      isHost,
      connectedAt: Date.now(),
    };
    this.players.set(userId, info);

    if (isHost) {
      this.hostId = userId;
    }

    this.setInactivityAlarm();

    const newPlayer: PlayerSummary = {
      userId,
      username,
      displayName,
      avatarKey,
      isReady: false,
      isHost,
    };
    this.broadcast({ type: 'player_joined', player: newPlayer }, userId);

    const playerList = this.getPlayerSummaries();
    const roomMeta: RoomMetadata = {
      roomId: this.roomId,
      gameId: this.gameId,
      hostId: this.hostId,
      status: this.status,
      maxPlayers: this.maxPlayers,
      isPublic: this.isPublic,
      createdAt: this.createdAt,
    };
    const stateMsg: ServerMessage = { type: 'room_state', room: roomMeta, players: playerList };
    try {
      server.send(JSON.stringify(stateMsg));
    } catch {
      // ignore
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleApiPost(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        action: string;
        userId?: string;
        state?: unknown;
        winner?: string;
        scores?: Record<string, number>;
      };

      switch (body.action) {
        case 'set_public':
          this.isPublic = body.state as unknown as boolean;
          return new Response('OK', { status: 200 });

        case 'set_max_players':
          this.maxPlayers = body.state as unknown as number;
          return new Response('OK', { status: 200 });

        case 'end_game':
          this.status = 'finished';
          if (body.winner || body.scores) {
            this.broadcast({
              type: 'game_over',
              winner: body.winner,
              scores: body.scores,
            });
          }
          this.cleanup();
          return new Response('OK', { status: 200 });

        case 'force_close':
          const forceMsg: ServerMessage = { type: 'error', code: 'ROOM_CLOSED', message: 'Room closed by host' };
          this.broadcast(forceMsg);
          this.cleanup();
          return new Response('OK', { status: 200 });

        default:
          return new Response('Unknown action', { status: 400 });
      }
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
  }

  private handleApiGet(): Response {
    return new Response(
      JSON.stringify({
        roomId: this.roomId,
        gameId: this.gameId,
        hostId: this.hostId,
        status: this.status,
        maxPlayers: this.maxPlayers,
        isPublic: this.isPublic,
        playerCount: this.players.size,
        players: this.getPlayerSummaries(),
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let data: ClientMessage;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const player = this.findPlayerByWs(ws);
    if (!player) return;

    this.setInactivityAlarm();

    switch (data.type) {
      case 'ready':
        player.isReady = data.ready;
        this.broadcast({ type: 'player_ready', userId: player.userId, ready: data.ready });
        break;

      case 'start_game':
        if (!player.isHost) {
          this.sendTo(player.userId, { type: 'error', code: 'NOT_HOST', message: 'Only host can start the game' });
          return;
        }
        if (this.players.size < 2) {
          this.sendTo(player.userId, { type: 'error', code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 2 players' });
          return;
        }
        this.status = 'playing';
        this.broadcast({ type: 'game_start' });
        break;

      case 'input':
        this.broadcast({ type: 'player_input', userId: player.userId, input: data.input }, player.userId);
        break;

      case 'chat':
        this.broadcast({ type: 'chat', userId: player.userId, username: player.username, message: data.message });
        break;

      case 'request_state':
        const roomMeta: RoomMetadata = {
          roomId: this.roomId,
          gameId: this.gameId,
          hostId: this.hostId,
          status: this.status,
          maxPlayers: this.maxPlayers,
          isPublic: this.isPublic,
          createdAt: this.createdAt,
        };
        this.sendTo(player.userId, { type: 'room_state', room: roomMeta, players: this.getPlayerSummaries() });
        if (this.gameState !== null) {
          this.sendTo(player.userId, { type: 'game_state', state: this.gameState, timestamp: Date.now() });
        }
        break;

      case 'leave':
        this.removePlayer(player.userId);
        break;

      case 'signal':
        this.sendTo(data.targetUserId, { type: 'signal', userId: player.userId, signal: data.signal });
        break;

      case 'peer_data':
        this.broadcast({ type: 'peer_data', userId: player.userId, data: data.data }, player.userId);
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const player = this.findPlayerByWs(ws);
    if (player) {
      this.removePlayer(player.userId);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const player = this.findPlayerByWs(ws);
    if (player) {
      this.removePlayer(player.userId);
    }
  }

  async alarm(): Promise<void> {
    if (this.players.size === 0) {
      return;
    }

    if (this.status === 'lobby' && Date.now() - this.createdAt > LOBBY_TIMEOUT_MS) {
      this.broadcast({ type: 'error', code: 'ROOM_TIMEOUT', message: 'Room expired due to inactivity' });
      this.cleanup();
      return;
    }

    const now = Date.now();
    const allInactive = Array.from(this.players.values()).every((p) => now - p.connectedAt > INACTIVITY_TIMEOUT_MS);
    if (allInactive && this.players.size > 0) {
      this.broadcast({ type: 'error', code: 'ROOM_TIMEOUT', message: 'Room expired due to inactivity' });
      this.cleanup();
    }
  }

  private removePlayer(userId: string): void {
    this.players.delete(userId);

    if (this.players.size === 0) {
      this.cleanup();
      return;
    }

    this.broadcast({ type: 'player_left', userId });

    if (userId === this.hostId) {
      const newHost = this.players.values().next().value;
      if (newHost) {
        newHost.isHost = true;
        this.hostId = newHost.userId;
        this.broadcast({ type: 'host_changed', newHostId: newHost.userId });
      }
    }

    if (this.players.size === 1 && this.status === 'playing') {
      const remaining = this.players.values().next().value;
      this.status = 'finished';
      const result: ServerMessage = {
        type: 'game_over',
        winner: remaining?.userId,
      };
      this.broadcast(result);
      this.cleanup();
    }
  }

  private cleanup(): void {
    for (const [, info] of this.players) {
      try {
        info.ws.close(1000, 'Room closed');
      } catch {
        // ignore
      }
    }
    this.players.clear();
    this.ctx.storage.deleteAlarm();
  }

  private setInactivityAlarm(): void {
    this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
  }

  private getPlayerSummaries(): PlayerSummary[] {
    return Array.from(this.players.values()).map((p) => ({
      userId: p.userId,
      username: p.username,
      displayName: p.displayName,
      avatarKey: p.avatarKey,
      isReady: p.isReady,
      isHost: p.isHost,
    }));
  }

  private findPlayerByWs(ws: WebSocket): PlayerInfo | undefined {
    for (const [, info] of this.players) {
      if (info.ws === ws) return info;
    }
    return undefined;
  }

  private broadcast(msg: ServerMessage, excludeUserId?: string): void {
    const payload = JSON.stringify(msg);
    for (const [id, info] of this.players) {
      if (id === excludeUserId) continue;
      try {
        info.ws.send(payload);
      } catch {
        // ignore
      }
    }
  }

  private sendTo(targetUserId: string, msg: ServerMessage): void {
    const info = this.players.get(targetUserId);
    if (info) {
      try {
        info.ws.send(JSON.stringify(msg));
      } catch {
        // ignore
      }
    }
  }
}

interface MatchmakerEntry {
  userId: string;
  username: string;
  gameId: string;
  joinedAt: number;
}

export class Matchmaker {
  private ctx: DurableObjectState;
  private queue: Map<string, MatchmakerEntry[]> = new Map();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'POST') {
      const body = (await request.json()) as {
        action: string;
        userId: string;
        username: string;
        gameId: string;
        maxPlayers?: number;
      };

      switch (body.action) {
        case 'join_queue':
          return this.joinQueue(body.userId, body.username, body.gameId);

        case 'leave_queue':
          return this.leaveQueue(body.userId, body.gameId);

        case 'check_match':
          return this.checkMatch(body.userId, body.gameId, body.maxPlayers ?? 2);

        default:
          return new Response('Unknown action', { status: 400 });
      }
    }

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const gameId = url.searchParams.get('gameId');
      if (gameId) {
        const entries = this.queue.get(gameId) || [];
        return new Response(JSON.stringify({ queueSize: entries.length }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ queues: Object.fromEntries(this.queue.entries()) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Matchmaker DO', { status: 200 });
  }

  async alarm(): Promise<void> {
    for (const [gameId, entries] of this.queue) {
      if (entries.length > 0 && Date.now() - entries[0].joinedAt > 120_000) {
        entries.shift();
        if (entries.length === 0) {
          this.queue.delete(gameId);
        }
      }
    }
    if (this.queue.size > 0) {
      this.ctx.storage.setAlarm(Date.now() + 120_000);
    }
  }

  private async joinQueue(userId: string, username: string, gameId: string): Promise<Response> {
    if (!this.queue.has(gameId)) {
      this.queue.set(gameId, []);
    }

    const entries = this.queue.get(gameId)!;
    const existing = entries.find((e) => e.userId === userId);
    if (existing) {
      return new Response(JSON.stringify({ status: 'already_in_queue' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    entries.push({ userId, username, gameId, joinedAt: Date.now() });
    this.ctx.storage.setAlarm(Date.now() + 120_000);

    return new Response(JSON.stringify({ status: 'queued', position: entries.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async leaveQueue(userId: string, gameId: string): Promise<Response> {
    const entries = this.queue.get(gameId);
    if (!entries) {
      return new Response(JSON.stringify({ status: 'not_in_queue' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const idx = entries.findIndex((e) => e.userId === userId);
    if (idx === -1) {
      return new Response(JSON.stringify({ status: 'not_in_queue' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    entries.splice(idx, 1);
    if (entries.length === 0) {
      this.queue.delete(gameId);
    }

    return new Response(JSON.stringify({ status: 'left_queue' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async checkMatch(userId: string, gameId: string, maxPlayers: number): Promise<Response> {
    const entries = this.queue.get(gameId);
    if (!entries || entries.length < maxPlayers) {
      return new Response(JSON.stringify({ matched: false }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const matched = entries.splice(0, maxPlayers);
    if (entries.length === 0) {
      this.queue.delete(gameId);
    }

    return new Response(
      JSON.stringify({
        matched: true,
        players: matched.map((e) => ({ userId: e.userId, username: e.username })),
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }
}

export default {};
