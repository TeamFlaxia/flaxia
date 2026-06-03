/// <reference types="@cloudflare/workers-types" />

const _worker = globalThis as any;

export class NotificationStream {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const _url = new URL(request.url);

    // WebSocket アップグレード — デスクトップアプリからの接続
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      server.accept();
      this.ctx.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    // POST — サーバー側からの通知転送
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
