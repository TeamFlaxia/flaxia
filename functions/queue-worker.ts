/// <reference types="@cloudflare/workers-types" />

import { backfillGameTitles } from './lib/game-title-backfill.ts';
import { parsePublicHttpUrl } from './lib/url-guard.ts';

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

/** The consumer that drains quarantined messages into durable storage. */
export const AP_DLQ_QUEUE = 'activitypub-delivery-dlq';

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
  AP_POOL_SEED_DOMAINS?: string;
  CROWD_ORCHESTRATOR_URL?: string;
  CROWD_API_KEY?: string;
  CROWD_WEBHOOK_SECRET?: string;
  CC_CRAWL?: string;
  CC_DOMAINS?: string;
  WEB_EMBEDDINGS_ENABLED?: string;
}

export default {
  // Triggered by `triggers.crons` in wrangler.worker.toml — exports the
  // anonymized Arcade dwell dataset and uploads it to HuggingFace (optional).
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // pending_embeddings has no other autonomous consumer: new-post requests
    // are throttled and admin backfill is manual, so stranded rows never
    // completed. Drain a bounded batch on every scheduled run.
    try {
      const { drainPendingEmbeds } = await import('./lib/crowd');
      const { submitted, remaining } = await drainPendingEmbeds(env.DB, env, {
        maxBatch: 50,
        respectThrottle: false,
      });
      if (submitted > 0 || remaining > 0) {
        console.log(`Pending embeddings: submitted=${submitted} remaining=${remaining}`);
      }
    } catch (error) {
      console.error('Pending embedding drain failed:', (error as Error).message);
    }

    // The federated popularity pool runs before the hourly branch so its
    // schedule cannot be mistaken for Common Crawl ingestion.
    if (event.cron === '5 * * * *') {
      try {
        const { runPoolDiscovery, prunePool } = await import('./lib/activitypub/ap-pool.ts');
        const discovered = await runPoolDiscovery(env);
        const pruned = await prunePool(env);
        console.log(
          `Popularity pool finished: ${discovered.stored}/${discovered.fetched} posts stored, ${pruned} rows pruned`,
        );
      } catch (error) {
        console.error('Popularity pool discovery failed:', (error as Error).message);
      }
      return;
    }

    if (event.cron === '0 * * * *') {
      try {
        const { drainCcIngestion } = await import('./lib/cc-ingest');
        await drainCcIngestion(env);
      } catch (error) {
        console.error('Common Crawl ingestion failed:', (error as Error).message);
      }
      if (env.BUCKET) {
        try {
          await backfillGameTitles(env.DB, env.BUCKET, env.CACHE);
        } catch (error) {
          console.error('Game title backfill failed:', (error as Error).message);
        }
      }
      return;
    }

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

    // A dead letter is terminal: persisting it is the only work left. It must
    // never be retried like a delivery, otherwise a broken payload would loop
    // between the queue and the worker forever.
    if (batch.queue === AP_DLQ_QUEUE) {
      await storeDeadLetters(batch as unknown as MessageBatch<unknown>, env);
      return;
    }

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

function serializeDeadLetterValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** The original payload and the failure reason of a quarantined message. */
function deadLetterFields(body: unknown): { payload: string; error: string | null } {
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'payload' in parsed) {
        const envelope = parsed as { payload?: unknown; error?: unknown };
        return {
          payload: typeof envelope.payload === 'string' ? envelope.payload : serializeDeadLetterValue(envelope.payload),
          error:
            envelope.error === undefined
              ? null
              : typeof envelope.error === 'string'
                ? envelope.error
                : serializeDeadLetterValue(envelope.error),
        };
      }
    } catch {
      // An arbitrary string is a perfectly valid queue payload: keep it as-is.
    }
    return { payload: body, error: null };
  }
  return { payload: serializeDeadLetterValue(body), error: null };
}

/**
 * Persist dead letters and acknowledge every message.
 *
 * The queue keeps a dead letter only for its retention window (four days by
 * default). D1 is the durable copy. A missing table or a database outage must
 * not turn the DLQ consumer into an infinite retry loop, so failures are
 * logged and the message is acked either way.
 */
export async function storeDeadLetters(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const { payload, error } = deadLetterFields(message.body);
      await env.DB.prepare('INSERT INTO ap_dlq (id, queue, payload, error, received_at) VALUES (?, ?, ?, ?, ?)')
        .bind(message.id, batch.queue, payload, error, new Date().toISOString())
        .run();
      message.ack();
    } catch (cause) {
      console.error('Could not persist an ActivityPub dead letter (acknowledging to avoid a retry loop):', {
        messageId: message.id,
        error: (cause as Error).message,
      });
      message.ack();
    }
  }
}

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
