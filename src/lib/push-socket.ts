// Notification WebSocket client (split out of main.ts).
//
// Single-connection guard + capped exponential backoff: reconnect delays grow
// 10s → 20s → … → 5min instead of hammering a struggling server every 10s
// forever. Reset the backoff on every successful open.
export interface PushSocketEvents {
  onOpen: () => void;
  onMessage: (data: unknown) => void;
}

const BASE_DELAY_MS = 10000;
const MAX_DELAY_MS = 5 * 60 * 1000;

export interface PushSocket {
  connect: () => void;
  disconnect: () => void;
}

export function createPushSocket(buildUrl: () => string, events: PushSocketEvents): PushSocket {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let closed = false;

  const scheduleReconnect = () => {
    if (closed || timer) return;
    const delay = Math.min(BASE_DELAY_MS * 2 ** failures, MAX_DELAY_MS);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed || ws) return;
    try {
      const socket = new WebSocket(buildUrl());
      socket.onopen = () => {
        failures = 0;
        events.onOpen();
      };
      socket.onmessage = (ev) => {
        try {
          events.onMessage(JSON.parse(ev.data));
        } catch (e) {
          console.error('[push] parse error:', e);
        }
      };
      socket.onclose = (ev) => {
        ws = null;
        failures += 1;
        console.log(`[push] disconnected (code=${ev.code}), backing off`);
        scheduleReconnect();
      };
      socket.onerror = () => {
        console.error('[push] WebSocket error');
      };
      ws = socket;
    } catch {
      console.error('[push] connection error');
      ws = null;
      failures += 1;
      scheduleReconnect();
    }
  };

  const disconnect = () => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (ws) {
      // Suppress the onclose → reconnect path for an intentional close.
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  };

  return { connect, disconnect };
}
