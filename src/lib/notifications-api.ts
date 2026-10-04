// Notifications fetch with short TTL cache (split out of main.ts).
//
// Pure data access: no badge or nav side effects. Callers update their own
// unread-count state from the returned payload.
export interface NotificationData {
  notifications: Array<{
    id: string;
    type:
      | 'reported'
      | 'fresh'
      | 'warned'
      | 'hidden'
      | 'ap_follow'
      | 'ap_like'
      | 'ap_announce'
      | 'reply'
      | 'mention'
      | 'poll_ended';
    post_id: string;
    post_text_preview: string;
    actor?: {
      username: string;
      display_name: string;
      avatar_key: string | null;
    };
    read: boolean;
    created_at: string;
  }>;
  unread_count: number;
}

let cachedNotifications: NotificationData | null = null;
let lastNotificationFetch = 0;
const NOTIFICATION_FETCH_TTL = 10000; // 10秒以内の連続fetchはキャッシュ

export const fetchNotifications = async (): Promise<NotificationData> => {
  const now = Date.now();
  if (cachedNotifications && now - lastNotificationFetch < NOTIFICATION_FETCH_TTL) {
    return cachedNotifications;
  }
  try {
    const response = await fetch('/api/notifications', { credentials: 'include' });
    if (response.ok) {
      const data = (await response.json()) as NotificationData;
      cachedNotifications = data;
      lastNotificationFetch = now;
      return data;
    }
  } catch (error) {
    console.log('Failed to fetch notifications:', error);
  }
  return { notifications: [], unread_count: 0 };
};

/** Drop the cache so the next fetch gets fresh data (e.g. after mark-all-read). */
export function invalidateNotificationsCache(): void {
  cachedNotifications = null;
  lastNotificationFetch = 0;
}
