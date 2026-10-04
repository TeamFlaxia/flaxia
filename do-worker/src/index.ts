/// <reference types="@cloudflare/workers-types" />

// #110: dispatch payload ceiling (notification + push payload, with margin).
const MAX_DISPATCH_BYTES = 16_000;

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
      // #110: the DO only speaks its own notification protocol. Reachable
      // solely via worker bindings (per-user stub from session context or
      // server-side dispatch), but a compromised caller must still not be
      // able to blast arbitrary bytes to every socket in the namespace.
      const body = await request.text();
      if (body.length > MAX_DISPATCH_BYTES) {
        return new Response('Payload too large', { status: 413 });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'notification') {
        return new Response('Unknown message type', { status: 400 });
      }
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

export default {};
