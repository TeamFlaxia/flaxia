import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as worker from '../functions/queue-worker.ts';
import { createTestDatabase } from './helpers/d1.ts';

const queueWorker = worker.default;
const AP_DLQ_QUEUE = worker.AP_DLQ_QUEUE;
type QueueBatch = Parameters<typeof queueWorker.queue>[0];
type QueueEnv = Parameters<typeof queueWorker.queue>[1];
type ScheduledEvent = Parameters<typeof queueWorker.scheduled>[0];

const PRIVATE_ACTIVITY = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  id: 'https://remote.example/activities/secret-create',
  type: 'Create',
  actor: 'https://remote.example/actors/alice',
  to: ['https://remote.example/actors/bob'],
  cc: ['https://remote.example/followers/alice'],
  object: {
    id: 'https://remote.example/notes/secret-1',
    type: 'Note',
    content: '<p>launch plan for eyes only</p>',
    to: ['https://remote.example/actors/bob'],
    cc: ['https://remote.example/followers/alice'],
  },
};

const PUBLIC_COLLECTION = 'https://www.w3.org/ns/activitystreams#Public';
const PUBLIC_ACTIVITY = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  id: 'https://remote.example/activities/public-create',
  type: 'Create',
  actor: 'https://remote.example/actors/alice',
  to: [PUBLIC_COLLECTION],
  cc: ['https://remote.example/followers/alice'],
  object: {
    id: 'https://remote.example/notes/public-1',
    type: 'Note',
    content: 'hello federation',
    to: [PUBLIC_COLLECTION],
    cc: ['https://remote.example/followers/alice'],
  },
};

function dlqBatch(bodies: unknown[]): { batch: QueueBatch; acked: string[]; retried: string[] } {
  const acked: string[] = [];
  const retried: string[] = [];
  const messages = bodies.map((body, index) => {
    const id = `privacy-${index}`;
    return {
      id,
      attempts: 1,
      timestamp: new Date('2026-01-02T00:00:00.000Z'),
      body,
      ack: () => acked.push(id),
      retry: () => retried.push(id),
    };
  });
  return { batch: { queue: AP_DLQ_QUEUE, messages } as unknown as QueueBatch, acked, retried };
}

function fakeEnv(db: unknown): QueueEnv {
  return { DB: db as QueueEnv['DB'], BASE_URL: 'https://flaxia.app' };
}

async function storedRow(db: ReturnType<typeof createTestDatabase>, id: string) {
  return db
    .prepare('SELECT id, queue, payload, error FROM ap_dlq WHERE id = ?')
    .bind(id)
    .first<{ id: string; queue: string; payload: string; error: string | null }>();
}

describe('ap_dlq privacy', () => {
  it('redacts a non-public Create while keeping structure and the failure reason', async () => {
    const db = createTestDatabase();
    try {
      const original = {
        type: 'delivery',
        inboxUrl: 'https://peer.example/inbox',
        activity: PRIVATE_ACTIVITY,
        senderUsername: 'alice',
      };
      const envelope = JSON.stringify({ payload: JSON.stringify(original), error: '422 rejected by peer' });
      const { batch, acked, retried } = dlqBatch([envelope]);

      await queueWorker.queue(batch, fakeEnv(db));

      const row = await storedRow(db, 'privacy-0');
      assert.ok(row, 'the dead letter must still be persisted');
      assert.equal(row.queue, AP_DLQ_QUEUE);
      assert.equal(row.error, '422 rejected by peer');
      assert.deepEqual(JSON.parse(row.payload), {
        type: 'delivery',
        inboxUrl: 'https://peer.example/inbox',
        activity: {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: 'https://remote.example/activities/secret-create',
          type: 'Create',
          actor: 'https://remote.example/actors/alice',
          object: { id: 'https://remote.example/notes/secret-1', type: 'Note' },
        },
        senderUsername: 'alice',
      });
      for (const secret of ['launch plan for eyes only', 'actors/bob', 'followers/alice']) {
        assert.equal(row.payload.includes(secret), false, `stored payload leaked ${secret}`);
      }
      assert.equal(envelope, JSON.stringify({ payload: JSON.stringify(original), error: '422 rejected by peer' }));
      assert.deepEqual(acked, ['privacy-0'], 'a redacted dead letter is still acknowledged');
      assert.deepEqual(retried, [], 'redaction must not change retry semantics');
    } finally {
      db.close();
    }
  });

  it('keeps a public Create payload verbatim', async () => {
    const db = createTestDatabase();
    try {
      const original = {
        type: 'inbox',
        username: 'alice',
        activity: PUBLIC_ACTIVITY,
        actorId: 'https://remote.example/actors/alice',
      };
      const envelope = JSON.stringify({ payload: JSON.stringify(original), error: '503 peer unavailable' });
      const { batch, acked } = dlqBatch([envelope]);

      await queueWorker.queue(batch, fakeEnv(db));

      const row = await storedRow(db, 'privacy-0');
      assert.ok(row);
      assert.equal(row.error, '503 peer unavailable');
      assert.equal(row.payload, JSON.stringify(original));
      assert.deepEqual(acked, ['privacy-0']);
    } finally {
      db.close();
    }
  });

  it('prunes dead letters older than the cutoff and keeps recent ones', async () => {
    const db = createTestDatabase();
    try {
      for (const [id, receivedAt] of [
        ['old-a', '2026-01-01T00:00:00.000Z'],
        ['old-b', '2026-01-10T00:00:00.000Z'],
        ['recent', '2026-01-20T00:00:00.000Z'],
      ]) {
        await db
          .prepare('INSERT INTO ap_dlq (id, queue, payload, error, received_at) VALUES (?, ?, ?, ?, ?)')
          .bind(id, AP_DLQ_QUEUE, '{}', null, receivedAt)
          .run();
      }

      const removed = await worker.pruneDeadLetters(db as unknown as QueueEnv['DB'], '2026-01-15T00:00:00.000Z');
      assert.equal(removed, 2);
      const remaining = await db.prepare('SELECT id FROM ap_dlq ORDER BY id').all<{ id: string }>();
      assert.deepEqual(
        remaining.results.map((row) => row.id),
        ['recent'],
      );
    } finally {
      db.close();
    }
  });

  it('runs the D1 prune from its dedicated daily cron branch', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            calls.push({ sql, values });
            return this;
          },
          async run() {
            return { success: true, meta: { changes: 0, last_row_id: 0 } };
          },
        };
      },
    };
    const event = { cron: '30 4 * * *', scheduledTime: Date.now(), noRetry: () => {} } as unknown as ScheduledEvent;

    await queueWorker.scheduled(event, fakeEnv(db));

    assert.equal(calls.length, 1, 'the prune cron must not trigger unrelated cleanup');
    assert.match(calls[0].sql, /DELETE FROM ap_dlq/);
    assert.equal(calls[0].values.length, 1);
    const cutoff = new Date(String(calls[0].values[0])).getTime();
    assert.ok(Number.isFinite(cutoff), 'the cutoff must be a date string');
    assert.equal(worker.AP_DLQ_RETENTION_DAYS, 14);
    assert.ok(Math.abs(Date.now() - cutoff - 14 * 24 * 60 * 60 * 1000) < 60_000, 'cutoff is 14 days ago');

    const toml = readFileSync(new URL('../wrangler.worker.toml', import.meta.url), 'utf8');
    assert.match(toml, /crons\s*=\s*\[[^\]]*"30 4 \* \* \*"/);
  });
});
