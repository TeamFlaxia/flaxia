/// <reference types="@cloudflare/workers-types" />

import { type FederationEnv, resolveRemoteActor } from './fetch.ts';
import { signRequest } from './signature.ts';

/**
 * Delivery of activities to remote instances.
 *
 * Every follower is reached through its own inbox, but instances with a
 * shared inbox expect one delivery per inbox instead of one per follower.
 * The delivery therefore collects the inboxes of all followers first and
 * sends a single activity to each of them.
 */

export interface DeliveryEnv extends FederationEnv {
  DB: D1Database;
  BASE_URL: string;
  AP_DELIVERY_QUEUE?: Queue;
}

export interface DeliveryActivity {
  type?: string;
  [key: string]: unknown;
}

/**
 * True when the activities are delivered without the queue.
 */
export function isDirectDelivery(env: DeliveryEnv): boolean {
  return env.AP_DIRECT_DELIVERY === '1' || env.AP_DIRECT_DELIVERY === 'true';
}

/**
 * Deliver an activity to an inbox right away.
 *
 * The activity is signed with the key of the sending account, exactly like a
 * queued delivery does.
 */
export async function deliverDirect(
  env: DeliveryEnv,
  options: { inboxUrl: string; username: string; activity: DeliveryActivity },
): Promise<boolean> {
  const key = await env.DB.prepare(
    `SELECT ak.private_key_pem FROM actor_keys ak JOIN users u ON u.id = ak.user_id
     WHERE u.username = ? COLLATE NOCASE`,
  )
    .bind(options.username)
    .first<{ private_key_pem: string }>();
  if (!key?.private_key_pem) {
    console.error('No private key found for user:', options.username);
    return false;
  }

  const keyId = `${env.BASE_URL}/api/actors/${options.username}#main-key`;
  const body = JSON.stringify(options.activity);
  const headers = await signRequest(options.inboxUrl, body, key.private_key_pem, keyId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(options.inboxUrl, {
      method: 'POST',
      headers,
      body,
      // A redirect is not followed: the signature is bound to the inbox it
      // was made for.
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error('Direct ActivityPub delivery failed:', {
        status: response.status,
        activityType: options.activity.type,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error('Direct ActivityPub delivery failed:', {
      name: (error as Error).name,
      message: (error as Error).message,
      inboxUrl: options.inboxUrl,
      activityType: options.activity.type,
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
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
  const inboxes = await collectFollowerInboxes(env, options.userId);
  for (const inboxUrl of inboxes) {
    await deliverToInbox(env, {
      inboxUrl,
      username: options.username,
      activity: options.activity,
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
  if (isDirectDelivery(env)) {
    await deliverDirect(env, options);
    return;
  }
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

/**
 * The inbox a remote actor is reached at.
 *
 * The cached actor document is used when it is known, otherwise the document
 * is fetched once and cached. The shared inbox of the instance wins over the
 * personal inbox of the actor.
 */
export async function resolveActorInbox(env: DeliveryEnv, actorUrl: string): Promise<string | null> {
  const cached = await env.DB.prepare('SELECT inbox_url, shared_inbox_url FROM ap_actors WHERE actor_url = ? LIMIT 1')
    .bind(actorUrl)
    .first<{ inbox_url: string; shared_inbox_url: string | null }>();
  if (cached) return cached.shared_inbox_url || cached.inbox_url;

  const actor = await resolveRemoteActor(actorUrl, env);
  if (!actor) return null;

  await env.DB.prepare(`
    INSERT INTO ap_actors (actor_url, inbox_url, shared_inbox_url, public_key_pem, preferred_username, display_name, icon_url, domain, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(actor_url) DO UPDATE SET
      inbox_url = excluded.inbox_url,
      shared_inbox_url = excluded.shared_inbox_url,
      public_key_pem = excluded.public_key_pem,
      preferred_username = excluded.preferred_username,
      display_name = excluded.display_name,
      icon_url = excluded.icon_url,
      domain = excluded.domain,
      fetched_at = excluded.fetched_at
  `)
    .bind(
      actor.actorUrl,
      actor.inbox,
      actor.sharedInbox,
      actor.publicKeyPem,
      actor.preferredUsername,
      actor.displayName,
      actor.iconUrl,
      actor.domain,
    )
    .run();

  return actor.sharedInbox || actor.inbox;
}

/**
 * Queue an activity for the inbox of a remote actor.
 *
 * Used for the activities that address a single remote account, such as the
 * like of a post that was published by that account.
 */
export async function deliverToActorInbox(
  env: DeliveryEnv,
  options: { actorUrl: string; username: string; activity: DeliveryActivity },
): Promise<void> {
  const inboxUrl = await resolveActorInbox(env, options.actorUrl);
  if (!inboxUrl) return;
  await deliverToInbox(env, { inboxUrl, username: options.username, activity: options.activity });
}
