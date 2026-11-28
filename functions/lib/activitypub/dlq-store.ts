/// <reference types="@cloudflare/workers-types" />

import { isPublicAddress } from './context.ts';

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

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** bto/bcc/audience can carry addresses but never make an activity public. */
const PUBLIC_ADDRESS_KEYS = ['to', 'cc'] as const;

/** Fields that can carry a private body or its audience. */
const PRIVATE_KEYS = [
  'to',
  'cc',
  'bto',
  'bcc',
  'audience',
  'content',
  'contentMap',
  'summary',
  'name',
  'attachment',
] as const;

/** Records nested inside an activity that may themselves carry a body. */
const NESTED_RECORD_KEYS = ['object', 'activity'] as const;

/** Bound the walk so a hostile payload cannot exhaust the consumer. */
const MAX_REDACT_DEPTH = 16;

function addressesPublic(record: JsonRecord): boolean {
  return PUBLIC_ADDRESS_KEYS.some((key) => isPublicAddress(record[key]));
}

/** Replace a record beyond the depth limit with just its identifier. */
function truncateRecord(record: JsonRecord): JsonRecord {
  return typeof record.id === 'string' ? { id: record.id } : {};
}

/**
 * Redact one ActivityStreams record and every nested object/activity record.
 *
 * A record that explicitly addresses the Public collection keeps its fields:
 * that material is already published. Everything else loses its body, its
 * audience and its attachments while the structural fields stay behind so an
 * operator can still identify the failed delivery.
 */
function redactRecord(record: JsonRecord, depth: number): boolean {
  let changed = false;
  if (!addressesPublic(record)) {
    for (const key of PRIVATE_KEYS) {
      if (key in record) {
        delete record[key];
        changed = true;
      }
    }
  }

  for (const key of NESTED_RECORD_KEYS) {
    const value = record[key];
    if (isJsonRecord(value)) {
      if (depth >= MAX_REDACT_DEPTH) {
        record[key] = truncateRecord(value);
        changed = true;
      } else if (redactRecord(value, depth + 1)) {
        changed = true;
      }
    } else if (Array.isArray(value)) {
      const kept: unknown[] = [];
      for (const item of value) {
        if (!isJsonRecord(item)) {
          kept.push(item);
          continue;
        }
        if (depth >= MAX_REDACT_DEPTH) {
          kept.push(truncateRecord(item));
          changed = true;
        } else {
          if (redactRecord(item, depth + 1)) changed = true;
          kept.push(item);
        }
      }
      record[key] = kept;
    }
  }
  return changed;
}

/**
 * Drop private body fields from a non-public activity of any type before it
 * reaches D1. An activity (or its direct object) addressed to the Public
 * collection keeps its content: that is already published and useful when
 * redriving a poison message.
 */
function redactPrivateActivity(record: JsonRecord): boolean {
  const activity = isJsonRecord(record.activity) ? record.activity : record;
  const object = activity.object;
  if (addressesPublic(activity) || (isJsonRecord(object) && addressesPublic(object))) {
    return false;
  }
  return redactRecord(activity, 0);
}

/** Redact only the stored copy; the original queue message is never mutated. */
function redactDeadLetterPayload(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isJsonRecord(parsed)) return payload;

  // The DLQ envelope is {"payload": "<original message>", "error": "..."}.
  if (typeof parsed.payload === 'string') {
    const inner = redactDeadLetterPayload(parsed.payload);
    if (inner === parsed.payload) return payload;
    parsed.payload = inner;
    return JSON.stringify(parsed);
  }

  if (!redactPrivateActivity(parsed)) return payload;
  return JSON.stringify(parsed);
}

/** Remove dead letters older than `cutoffIso`; returns the number of rows. */
export async function pruneDeadLetters(db: D1Database, cutoffIso: string): Promise<number> {
  const result = await db.prepare('DELETE FROM ap_dlq WHERE received_at < ?').bind(cutoffIso).run();
  return result.meta?.changes ?? 0;
}

/**
 * Persist dead letters and acknowledge the messages that were stored.
 *
 * The queue keeps a dead letter only for its retention window (14 days by
 * default). D1 is the durable copy, but private bodies are redacted first and
 * a daily cron enforces a 14-day ceiling. When the INSERT fails the message
 * must stay on the queue: acking here would lose the quarantined delivery
 * during exactly the database outage the DLQ exists to survive. Queues applies
 * the bounded `max_retries` of this consumer, after which the message is
 * deleted or routed to its own dead letter queue.
 */
export async function storeDeadLetters(batch: MessageBatch<unknown>, env: { DB: D1Database }): Promise<void> {
  for (const message of batch.messages) {
    try {
      const { payload, error } = deadLetterFields(message.body);
      const storedPayload = redactDeadLetterPayload(payload);
      await env.DB.prepare('INSERT INTO ap_dlq (id, queue, payload, error, received_at) VALUES (?, ?, ?, ?, ?)')
        .bind(message.id, batch.queue, storedPayload, error, new Date().toISOString())
        .run();
      message.ack();
    } catch (cause) {
      console.error('Could not persist an ActivityPub dead letter (leaving it for a bounded retry):', {
        messageId: message.id,
        error: (cause as Error).message,
      });
      message.retry();
    }
  }
}
