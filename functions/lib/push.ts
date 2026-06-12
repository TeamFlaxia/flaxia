import webpush from 'web-push';
import { sendPushToDevice } from './fcm';

export type PushSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  type?: string;
  postId?: string;
}

let vapidKeys: { publicKey: string; privateKey: string } | null = null;

/**
 * Lazily initialise VAPID keys.
 * In production, pass VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY via env vars.
 * Falls back to auto-generated keys for development.
 */
function ensureVapid(vapidPublicKey?: string, vapidPrivateKey?: string, subject?: string) {
  if (vapidKeys) return;
  const pub = vapidPublicKey || VAPID_PUBLIC_KEY;
  const priv = vapidPrivateKey || VAPID_PRIVATE_KEY;
  if (pub && priv) {
    vapidKeys = { publicKey: pub, privateKey: priv };
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    console.warn('VAPID keys auto-generated. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars for production.');
  }
  webpush.setVapidDetails(subject || 'mailto:push@flaxia.app', vapidKeys!.publicKey, vapidKeys!.privateKey);
}

/**
 * Send a Web Push notification to a single PushSubscription.
 * Uses VAPID authentication (no Firebase required).
 */
export async function sendPushToSubscription(
  subscription: PushSubscription,
  payload: PushPayload,
  vapidPublicKey?: string,
  vapidPrivateKey?: string,
): Promise<boolean> {
  try {
    ensureVapid(vapidPublicKey, vapidPrivateKey);
    // Generate the request details but send via Workers' fetch()
    const details = webpush.generateRequestDetails(subscription, JSON.stringify(payload));

    const res = await fetch(details.endpoint, {
      method: details.method as 'POST',
      headers: details.headers as Record<string, string>,
      body: details.body as ReadableStream | string | undefined,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('Web Push send failed', res.status, body);
      // 410 Gone = subscription expired, should be removed
      if (res.status === 410) {
        return false; // signal that subscription should be deleted
      }
      return false;
    }

    return true;
  } catch (err) {
    console.error('Web Push send error', err);
    return false;
  }
}

/**
 * Send push notification to all subscriptions of a user.
 */
export async function sendPushToUser(
  db: D1Database,
  userId: string,
  payload: PushPayload,
  vapidPublicKey?: string,
  vapidPrivateKey?: string,
  env?: { FCM_SERVER_KEY?: string },
): Promise<void> {
  const { results } = (await db
    .prepare('SELECT type, endpoint, auth_key, p256dh_key FROM push_subscriptions WHERE user_id = ?')
    .bind(userId)
    .all()) as { results: { type: string; endpoint: string; auth_key: string; p256dh_key: string }[] };

  // Send all pushes in parallel, collect stale subscriptions
  const staleEndpoints: string[] = [];
  await Promise.allSettled(
    results.map(async (row) => {
      if (row.type === 'fcm') {
        const ok = await sendPushToDevice(row.endpoint, payload, env?.FCM_SERVER_KEY || '');
        if (!ok) staleEndpoints.push(row.endpoint);
      } else {
        const subscription: PushSubscription = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh_key, auth: row.auth_key },
        };
        const ok = await sendPushToSubscription(subscription, payload, vapidPublicKey, vapidPrivateKey);
        if (!ok) staleEndpoints.push(row.endpoint);
      }
    }),
  );

  // Batch-delete stale subscriptions
  if (staleEndpoints.length > 0) {
    await db.batch(
      staleEndpoints.map((ep) => db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(ep)),
    );
  }
}

export function getPushPayload(
  type: string,
  actorUsername?: string,
  actorDisplayName?: string,
  postPreview?: string,
  postId?: string,
): PushPayload {
  const name = actorUsername
    ? actorDisplayName && actorDisplayName !== actorUsername
      ? `@${actorUsername} (${actorDisplayName})`
      : `@${actorUsername}`
    : 'Someone';
  const preview = postPreview ? `: ${postPreview.slice(0, 50)}` : '';
  const url = postId ? `/thread/${postId}` : '/notifications';

  switch (type) {
    case 'fresh':
      return { title: 'Flaxia', body: `${name} freshed your post${preview}`, url, type: 'notification' };
    case 'reply':
      return { title: 'Flaxia', body: `${name} replied to you${preview}`, url, type: 'notification' };
    case 'mention':
      return { title: 'Flaxia', body: `${name} mentioned you${preview}`, url, type: 'notification' };
    case 'ap_follow':
      return { title: 'Flaxia', body: `${name} followed you`, url: '/notifications', type: 'notification' };
    case 'ap_like':
      return { title: 'Flaxia', body: `${name} liked your post${preview}`, url, type: 'notification' };
    case 'ap_announce':
      return { title: 'Flaxia', body: `${name} boosted your post${preview}`, url, type: 'notification' };
    case 'poll_ended':
      return { title: 'Flaxia', body: `Your poll has ended${preview}`, url, type: 'notification' };
    case 'bookmark':
      return { title: 'Flaxia', body: `${name} bookmarked your post${preview}`, url, type: 'notification' };
    case 'call':
      return {
        title: postPreview || 'Incoming call',
        body: `${name} is calling you`,
        url: `/call/${postId || ''}`,
        type: 'call',
        postId,
      };
    default:
      return { title: 'Flaxia', body: `New notification${preview}`, url: '/notifications', type: 'notification' };
  }
}

/** VAPID public key for use by the client (Push API subscribe call). */
export function getVapidPublicKey(vapidPublicKey?: string, vapidPrivateKey?: string): string {
  ensureVapid(vapidPublicKey, vapidPrivateKey);
  return vapidKeys!.publicKey;
}
