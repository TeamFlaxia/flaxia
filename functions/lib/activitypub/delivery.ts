/// <reference types="@cloudflare/workers-types" />

/**
 * Delivery of activities to remote instances.
 *
 * Every follower is reached through its own inbox, but instances with a
 * shared inbox expect one delivery per inbox instead of one per follower.
 * The delivery therefore collects the inboxes of all followers first and
 * sends a single activity to each of them.
 */

export interface DeliveryEnv {
  DB: D1Database;
  BASE_URL: string;
  AP_DELIVERY_QUEUE?: Queue;
}

export interface DeliveryActivity {
  type: string;
  [key: string]: unknown;
}

/**
 * Collect the inboxes a local account has to be reached at.
 *
 * The shared inbox of an instance wins over the personal inbox of a
 * follower: the shared inbox is the address the instance expects
 * deliveries at and it handles the fan-out itself.
 */
export async function collectFollowerInboxes(env: DeliveryEnv, localUserId: string): Promise<string[]> {
  const followers = await env.DB.prepare(`SELECT inbox_url, shared_inbox_url FROM ap_followers WHERE local_user_id = ?`)
    .bind(localUserId)
    .all<{ inbox_url: string; shared_inbox_url: string | null }>();

  const inboxes = new Set<string>();
  for (const follower of followers.results ?? []) {
    const inbox = follower.shared_inbox_url || follower.inbox_url;
    if (inbox) inboxes.add(inbox);
  }
  return [...inboxes];
}

/**
 * Queue an activity for every inbox of the followers of an account.
 *
 * Returns the number of queued deliveries.
 */
export async function deliverToFollowers(
  env: DeliveryEnv,
  options: { userId: string; username: string; activity: DeliveryActivity },
): Promise<number> {
  if (!env.AP_DELIVERY_QUEUE) return 0;

  const inboxes = await collectFollowerInboxes(env, options.userId);
  for (const inboxUrl of inboxes) {
    await env.AP_DELIVERY_QUEUE.send({
      type: 'delivery',
      inboxUrl,
      activity: options.activity,
      senderUsername: options.username,
    });
  }
  return inboxes.length;
}

/**
 * Queue an activity for a single inbox.
 */
export async function deliverToInbox(
  env: DeliveryEnv,
  options: { inboxUrl: string; username: string; activity: DeliveryActivity },
): Promise<void> {
  if (!env.AP_DELIVERY_QUEUE) return;
  await env.AP_DELIVERY_QUEUE.send({
    type: 'delivery',
    inboxUrl: options.inboxUrl,
    activity: options.activity,
    senderUsername: options.username,
  });
}

/**
 * Queue an activity for a remote account we follow.
 *
 * The shared inbox of that account is used when it is known.
 */
export async function deliverToRemoteActor(
  env: DeliveryEnv,
  options: { actorUrl: string; username: string; activity: DeliveryActivity },
): Promise<void> {
  const following = await env.DB.prepare(
    'SELECT target_inbox_url, shared_inbox_url FROM ap_following WHERE target_actor_url = ? LIMIT 1',
  )
    .bind(options.actorUrl)
    .first<{ target_inbox_url: string; shared_inbox_url: string | null }>();

  const inboxUrl = following?.shared_inbox_url || following?.target_inbox_url;
  if (!inboxUrl) return;
  await deliverToInbox(env, { inboxUrl, username: options.username, activity: options.activity });
}
