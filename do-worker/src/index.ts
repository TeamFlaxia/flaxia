/// <reference types="@cloudflare/workers-types" />

interface ParticipantInfo {
  userId: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
  ws: WebSocket;
  muted: boolean;
}

export class NotificationStream {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const _url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      this.ctx.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'GET') {
      return new Response('NotificationStream DO', { status: 200 });
    }

    if (request.method === 'POST') {
      const body = await request.text();
      const websockets = this.ctx.getWebSockets();
      for (const ws of websockets) {
        try {
          ws.send(body);
        } catch {
          // ignore disconnected sockets
        }
      }
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  }
}

interface SignalMessage {
  type: string;
  userId: string;
  username?: string;
  display_name?: string | null;
  avatar_key?: string | null;
  sdp?: string;
  candidate?: unknown;
  muted?: boolean;
  participants?: unknown[];
  targetUserId?: string;
}

export class CallStream {
  private ctx: DurableObjectState;
  private participants: Map<string, ParticipantInfo> = new Map();

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId') || '';
      const username = url.searchParams.get('username') || '';
      const displayName = url.searchParams.get('display_name') || null;
      const avatarKey = url.searchParams.get('avatar_key') || null;

      if (!userId) {
        return new Response('Missing userId', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      this.ctx.acceptWebSocket(server);

      const info: ParticipantInfo = {
        userId,
        username,
        displayName,
        avatarKey,
        ws: server,
        muted: false,
      };
      this.participants.set(userId, info);

      // Notify others about new participant
      const joinMsg: SignalMessage = {
        type: 'join',
        userId,
        username,
        display_name: displayName,
        avatar_key: avatarKey,
      };
      this.broadcast(joinMsg, userId);

      // Send current participant list to the new joiner
      const participantList = Array.from(this.participants.values()).map((p) => ({
        user_id: p.userId,
        username: p.username,
        display_name: p.displayName,
        avatar_key: p.avatarKey,
        muted: p.muted,
      }));
      const partsMsg: SignalMessage = {
        type: 'participants',
        userId: '',
        participants: participantList,
      };
      try {
        server.send(JSON.stringify(partsMsg));
      } catch {
        // ignore
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST') {
      const body = (await request.json()) as { action: string; userId?: string };
      if (body.action === 'end-call' && body.userId) {
        const msg: SignalMessage = { type: 'end-call', userId: body.userId };
        this.broadcast(msg);
        this.participants.clear();
      }
      return new Response('OK');
    }

    return new Response('CallStream DO', { status: 200 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let data: SignalMessage;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    switch (data.type) {
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        // Relay to specific user or broadcast
        if (data.targetUserId) {
          this.sendTo(data.targetUserId, data);
        } else {
          this.broadcast(data, data.userId);
        }
        break;

      case 'mute':
        if (data.userId) {
          const p = this.participants.get(data.userId);
          if (p) {
            p.muted = data.muted ?? false;
          }
          this.broadcast(data, data.userId);
        }
        break;

      case 'leave':
        this.participants.delete(data.userId);
        this.broadcast(data, data.userId);
        break;

      case 'end-call':
        this.participants.clear();
        this.broadcast(data);
        break;
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Find and remove the disconnected participant
    let disconnectedUserId: string | undefined;
    for (const [id, info] of this.participants) {
      if (info.ws === ws) {
        disconnectedUserId = id;
        break;
      }
    }

    if (disconnectedUserId) {
      this.participants.delete(disconnectedUserId);
      const msg: SignalMessage = { type: 'leave', userId: disconnectedUserId };
      this.broadcast(msg);

      // If no participants left, the call effectively ends
      if (this.participants.size === 0) {
        // DO will be garbage collected
      }
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    // Handle error same as close
    let disconnectedUserId: string | undefined;
    for (const [id, info] of this.participants) {
      if (info.ws === ws) {
        disconnectedUserId = id;
        break;
      }
    }

    if (disconnectedUserId) {
      this.participants.delete(disconnectedUserId);
      const msg: SignalMessage = { type: 'leave', userId: disconnectedUserId };
      this.broadcast(msg);
    }
  }

  private broadcast(msg: SignalMessage, excludeUserId?: string): void {
    const payload = JSON.stringify(msg);
    for (const [id, info] of this.participants) {
      if (id === excludeUserId) continue;
      try {
        info.ws.send(payload);
      } catch {
        // ignore failed sends
      }
    }
  }

  private sendTo(targetUserId: string, msg: SignalMessage): void {
    const info = this.participants.get(targetUserId);
    if (info) {
      try {
        info.ws.send(JSON.stringify(msg));
      } catch {
        // ignore
      }
    }
  }
}

export default {};
