/// <reference types="@cloudflare/workers-types" />

import { parsePublicHttpUrl } from './lib/url-guard';

interface DeliveryMessage {
  type: 'delivery';
  inboxUrl: string;
  activity: object;
  senderUsername: string;
}

interface InboxMessage {
  type: 'inbox';
  username: string;
  activity: object;
  actorId: string;
}

type QueueMessage = DeliveryMessage | InboxMessage;

interface Env {
  DB: D1Database;
  BASE_URL: string;
  AP_DELIVERY_QUEUE?: Queue;
  ENVIRONMENT?: string;
  AP_ALLOWED_PRIVATE_PEERS?: string;
  CACHE?: KVNamespace;
  EXPORT_KV?: KVNamespace;
  EXPORT_BUCKET?: R2Bucket;
  BUCKET?: R2Bucket;
  AUTH_SERVICE?: Fetcher;
  MAIL_SERVICE?: Fetcher;
  MAIL_INTERNAL_SECRET?: string;
  HF_TOKEN?: string;
  HF_REPO?: string;
}

export default {
  // Triggered by `triggers.crons` in wrangler.toml.worker — exports the
  // anonymized Arcade dwell dataset and uploads it to HuggingFace (optional).
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const { runDatasetExport } = await import('./lib/dataset-export');
      const count = await runDatasetExport(env);
      console.log(`Dataset export finished: ${count} records exported`);
    } catch (error) {
      console.error('Dataset export failed:', (error as Error).message);
    }
    try {
      const { reapStalePendingPosts } = await import('./lib/pending-reap');
      const reaped = await reapStalePendingPosts(env);
      if (reaped > 0) console.log(`Reaped ${reaped} stale pending posts`);
    } catch (error) {
      console.error('Pending reap failed:', (error as Error).message);
    }
    try {
      const { reapDirectDeletions } = await import('./lib/flaxia-direct-deletion');
      const reaped = await reapDirectDeletions(env);
      if (reaped > 0) console.log(`Completed ${reaped} pending account deletions`);
    } catch (error) {
      console.error('Account deletion recovery failed:', (error as Error).message);
    }
    try {
      const { reapMailDeletions } = await import('./lib/mail-deletion-reap');
      const reaped = await reapMailDeletions(env);
      if (reaped > 0) console.log(`Completed ${reaped} pending Mail deletions`);
    } catch (error) {
      console.error('Mail deletion retry failed:', (error as Error).message);
    }
    try {
      const { reapProfileMedia } = await import('./lib/profile-media-reap');
      const reaped = await reapProfileMedia(env);
      if (reaped > 0) console.log(`Deleted ${reaped} unreferenced profile images`);
    } catch (error) {
      console.error('Profile media cleanup failed:', (error as Error).message);
    }
    try {
      const { recomputeStaleTrustScores } = await import('./lib/trust');
      const refreshed = await recomputeStaleTrustScores(env.DB);
      if (refreshed > 0) console.log(`Recomputed trust scores for ${refreshed} users`);
    } catch (error) {
      console.error('Trust score recompute failed:', (error as Error).message);
    }
    try {
      const { cleanupExpiredBugReportSubmissions } = await import('./lib/bug-report-store');
      const removed = await cleanupExpiredBugReportSubmissions(env.DB);
      if (removed > 0) console.log(`Removed ${removed} expired bug report reservations`);
    } catch (error) {
      console.error('Bug report reservation cleanup failed:', (error as Error).message);
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    console.log(`Processing batch of ${batch.messages.length} messages`);

    for (const message of batch.messages) {
      try {
        console.log(`Processing message type: ${message.body.type}`);

        if (message.body.type === 'inbox') {
          await handleInboxActivity(message.body, env, message);
        } else if (message.body.type === 'delivery') {
          await handleDeliveryActivity(message.body, env, message);
        } else {
          console.error('Unknown message type:', (message.body as QueueMessage).type);
          message.ack();
        }
      } catch (error: unknown) {
        console.error('Error processing message:', {
          error: (error as Error).message,
          stack: (error as Error).stack,
          messageType: message.body.type,
          messageId: message.id,
        });

        // Let Queues apply max_retries and route poison messages to the DLQ.
        message.retry();
      }
    }
  },
};

async function handleDeliveryActivity(msg: DeliveryMessage, env: Env, message: Message<QueueMessage>): Promise<void> {
  const { inboxUrl, activity, senderUsername } = msg;
  const retryCount = Math.max(0, message.attempts - 1);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // The inbox URL is stored from a remote actor document, so it is re-validated
  // at delivery time: a poisoned row must not turn the queue into an
  // authenticated request forwarder to private addresses.
  let deliveryUrl: URL;
  try {
    deliveryUrl = parsePublicHttpUrl(inboxUrl);
  } catch {
    console.error('Blocked ActivityPub delivery to non-public inbox:', inboxUrl);
    message.ack();
    return;
  }

  try {
    // Get the user's private key for signing.
    const keyResult = await env.DB.prepare(`
      SELECT ak.private_key_pem FROM actor_keys ak
      JOIN users u ON u.id = ak.user_id
      WHERE u.username = ?
    `)
      .bind(senderUsername)
      .first();

    if (!keyResult || !keyResult.private_key_pem) {
      console.error('No private key found for user:', senderUsername);
      message.ack();
      return;
    }

    const privateKeyPem = keyResult.private_key_pem as string;
    const keyId = `${env.BASE_URL}/api/actors/${senderUsername}#main-key`;

    const { signRequest } = await import('./lib/activitypub/signature');
    const body = JSON.stringify(activity);
    const headers = await signRequest(deliveryUrl.toString(), body, privateKeyPem, keyId);

    // Add timeout and better error handling
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const response = await fetch(deliveryUrl.toString(), {
      method: 'POST',
      headers: headers,
      body: body,
      // The signature is bound to this inbox. A remote redirect is not
      // followed: it would forward a signed request to an unchecked
      // destination.
      redirect: 'manual',
      signal: controller.signal,
    });

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      console.log('ActivityPub delivery successful:', (activity as { type: string }).type);
      message.ack();
    } else if (response.status >= 300 && response.status < 400) {
      console.error('ActivityPub delivery was redirected:', {
        status: response.status,
        activityType: (activity as { type: string }).type,
      });
      message.ack();
    } else {
      console.error('ActivityPub delivery failed:', {
        status: response.status,
        activityType: (activity as { type: string }).type,
      });

      // Retry on server errors (5xx) or network issues
      if (response.status >= 500 || response.status === 429) {
        // Always retry transient failures, including the final allowed
        // attempt. Queues owns the retry ceiling and DLQ handoff.
        message.retry({ delaySeconds: 2 ** Math.min(retryCount, 3) * 30 });
      } else {
        // Don't retry client errors (4xx except 429)
        message.ack();
      }
    }
  } catch (e: unknown) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    console.error('ActivityPub delivery error:', {
      name: (e as Error).name,
      retryCount,
      activityType: (activity as { type: string }).type,
    });

    // A database or signing failure must also reach the DLQ after bounded
    // retries, rather than acknowledging and silently losing the activity.
    message.retry({ delaySeconds: 2 ** Math.min(retryCount, 3) * 30 });
  }
}

/**
 * Process an activity that was delivered to one of our inboxes.
 *
 * The handling itself lives in the ActivityPub module so it can be tested
 * without a queue: the worker only decides what to do with the message.
 */
async function handleInboxActivity(msg: InboxMessage, env: Env, message: Message<QueueMessage>): Promise<void> {
  const { username, activity, actorId } = msg;

  try {
    const { handleIncomingActivity } = await import('./lib/activitypub/handlers');
    await handleIncomingActivity(
      {
        DB: env.DB,
        BASE_URL: env.BASE_URL,
        AP_DELIVERY_QUEUE: env.AP_DELIVERY_QUEUE,
        ENVIRONMENT: env.ENVIRONMENT,
        AP_ALLOWED_PRIVATE_PEERS: env.AP_ALLOWED_PRIVATE_PEERS,
        CACHE: env.CACHE,
      },
      { activity: activity as Record<string, unknown>, actorId, username },
    );
    message.ack();
  } catch (e) {
    console.error('Inbox processing error:', e);
    message.retry();
  }
}
