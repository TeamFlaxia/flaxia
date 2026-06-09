import { getPushPayload, type PushPayload, sendPushToUser } from './push';

interface NotificationWSMessage {
  type: 'notification';
  unread_count: number;
  push: PushPayload;
}

/// WebSocket (Durable Object) 経由で通知を届ける
export async function dispatchToDO(
  env: { NOTIFICATION_STREAM?: DurableObjectNamespace },
  userId: string,
  payload: unknown,
): Promise<void> {
  if (!env.NOTIFICATION_STREAM) return;
  try {
    const doId = env.NOTIFICATION_STREAM.idFromName(userId);
    const stub = env.NOTIFICATION_STREAM.get(doId);
    await stub.fetch('http://internal/dispatch', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('[notify] dispatchToDO failed:', e);
  }
}

/// Web Push (browser) + FCM (mobile) + WebSocket (全プラットフォーム) に通知を送る
export async function sendPushToAll(
  env: {
    DB: D1Database;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    FCM_SERVER_KEY?: string;
    NOTIFICATION_STREAM?: DurableObjectNamespace;
  },
  userId: string,
  type: string,
  actorUsername?: string,
  actorDisplayName?: string,
  postPreview?: string,
  postId?: string,
): Promise<void> {
  const payload = getPushPayload(type, actorUsername, actorDisplayName, postPreview, postId);

  // Web Push (browser) + FCM (mobile)
  await sendPushToUser(env.DB, userId, payload, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env);

  // WebSocket (全プラットフォーム) — 未読数も一緒に送信してポーリング不要に
  if (env.NOTIFICATION_STREAM) {
    try {
      const unreadResult = (await env.DB.prepare(
        'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0',
      )
        .bind(userId)
        .first()) as { count: number } | null;

      const wsMsg: NotificationWSMessage = {
        type: 'notification',
        unread_count: unreadResult?.count ?? 0,
        push: payload,
      };

      await dispatchToDO(env as { NOTIFICATION_STREAM?: DurableObjectNamespace }, userId, wsMsg);
    } catch (e) {
      console.error('[notify] WebSocket notification dispatch failed:', e);
    }
  }
}
