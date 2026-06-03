import { getPushPayload, type PushPayload, sendPushToUser } from './push';

/// WebSocket (Durable Object) 経由でデスクトップアプリに通知を届ける
export async function dispatchToDO(
  env: { NOTIFICATION_STREAM?: DurableObjectNamespace },
  userId: string,
  payload: PushPayload,
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

/// Web Push (browser) + WebSocket (desktop) 両方に通知を送る
export async function sendPushToAll(
  env: {
    DB: D1Database;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    NOTIFICATION_STREAM?: DurableObjectNamespace;
  },
  userId: string,
  type: string,
  actorName?: string,
  postPreview?: string,
  postId?: string,
): Promise<void> {
  const payload = getPushPayload(type, actorName, postPreview, postId);

  // Web Push (browser)
  await sendPushToUser(env.DB, userId, payload, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  // WebSocket (desktop)
  await dispatchToDO(env as { NOTIFICATION_STREAM?: DurableObjectNamespace }, userId, payload);
}
