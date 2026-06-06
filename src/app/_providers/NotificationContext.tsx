'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';

interface NotificationContextValue {
  unreadCount: number;
  refreshUnreadCount: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue>({
  unreadCount: 0,
  refreshUnreadCount: async () => {},
});

export function useNotification() {
  return useContext(NotificationContext);
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { currentUser } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshUnreadCount = useCallback(async () => {
    if (!currentUser) { setUnreadCount(0); return; }
    try {
      const res = await fetch('/api/notifications', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json() as { notifications?: Array<{ is_read: number }> };
      const count = (data.notifications || []).filter(n => !n.is_read).length;
      setUnreadCount(count);
    } catch {}
  }, [currentUser]);

  // Poll every 15s when logged in
  useEffect(() => {
    if (!currentUser) {
      setUnreadCount(0);
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      return;
    }
    refreshUnreadCount();
    intervalRef.current = setInterval(refreshUnreadCount, 15000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [currentUser, refreshUnreadCount]);

  // WebSocket push notifications (Tauri desktop / Capacitor)
  useEffect(() => {
    if (!currentUser) return;
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.host}/api/ws/notifications`;
        ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as { type?: string; title?: string; body?: string };
            if (data.type === 'notification') {
              refreshUnreadCount();
              if ('Notification' in window && Notification.permission === 'granted' && data.title) {
                new Notification(data.title, { body: data.body });
              }
            }
          } catch {}
        };

        ws.onclose = () => {
          wsRef.current = null;
          reconnectTimeout = setTimeout(connect, 5000);
        };

        ws.onerror = () => { ws?.close(); };
      } catch {
        reconnectTimeout = setTimeout(connect, 10000);
      }
    };

    connect();
    return () => {
      ws?.close();
      wsRef.current = null;
      clearTimeout(reconnectTimeout);
    };
  }, [currentUser, refreshUnreadCount]);

  return (
    <NotificationContext.Provider value={{ unreadCount, refreshUnreadCount }}>
      {children}
    </NotificationContext.Provider>
  );
}
