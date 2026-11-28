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

  it('redacts summary, name and attachments of a private Create', async () => {
    const db = createTestDatabase();
    try {
      const secret = {
        type: 'delivery',
        inboxUrl: 'https://peer.example/inbox',
        activity: {
          type: 'Create',
          actor: 'https://remote.example/actors/alice',
          to: ['https://remote.example/actors/bob'],
          cc: ['https://remote.example/followers/alice'],
          bto: ['https://remote.example/actors/dave'],
          audience: ['https://remote.example/actors/eve'],
          summary: 'private warning',
          object: {
            id: 'https://remote.example/notes/secret-2',
            type: 'Note',
            content: 'eyes only',
            summary: 'content warning for eyes only',
            name: 'private title',
            attachment: [{ type: 'Document', url: 'https://remote.example/media/private.zip' }],
            bcc: ['https://remote.example/actors/frank'],
          },
        },
      };
      const { batch } = dlqBatch([JSON.stringify({ payload: JSON.stringify(secret), error: null })]);
      await queueWorker.queue(batch, fakeEnv(db));
      const row = await storedRow(db, 'privacy-0');
      assert.ok(row);
      assert.deepEqual(JSON.parse(row.payload), {
        type: 'delivery',
        inboxUrl: 'https://peer.example/inbox',
        activity: {
          type: 'Create',
          actor: 'https://remote.example/actors/alice',
          object: { id: 'https://remote.example/notes/secret-2', type: 'Note' },
        },
      });
      for (const leak of [
        'private warning',
        'content warning for eyes only',
        'private title',
        'private.zip',
        'actors/dave',
        'actors/eve',
        'actors/frank',
        'eyes only',
      ]) {
        assert.equal(row.payload.includes(leak), false, `stored payload leaked ${leak}`);
      }
    } finally {
      db.close();
    }
  });

  it('redacts a private Update with nested content and a contentMap', async () => {
    const db = createTestDatabase();
    try {
      const original = {
        type: 'delivery',
        inboxUrl: 'https://peer.example/inbox',
        activity: {
          id: 'https://remote.example/activities/secret-update',
          type: 'Update',
          actor: 'https://remote.example/actors/alice',
          to: ['https://remote.example/actors/bob'],
          cc: [],
          object: {
            id: 'https://remote.example/notes/secret-update',
            type: 'Note',
            content: 'updated secret body',
            contentMap: { en: 'updated secret body', ja: '秘密' },
            summary: 'private CW',
            name: 'private title',
            attachment: [{ type: 'Document', url: 'https://remote.example/media/private.png' }],
            object: {
              id: 'https://remote.example/notes/nested',
              type: 'Note',
              content: 'nested secret',
              to: ['https://remote.example/actors/carol'],
              attachment: [{ type: 'Document', name: 'nested file', url: 'https://remote.example/media/nested.zip' }],
            },
          },
        },
        senderUsername: 'alice',
      };
      const envelope = JSON.stringify({ payload: JSON.stringify(original), error: '422 rejected' });
      const { batch, acked } = dlqBatch([envelope]);

      await queueWorker.queue(batch, fakeEnv(db));

      const row = await storedRow(db, 'privacy-0');
      assert.ok(row);
      const stored = JSON.parse(row.payload);
      assert.deepEqual(stored.activity.object, {
        id: 'https://remote.example/notes/secret-update',
        type: 'Note',
        object: { id: 'https://remote.example/notes/nested', type: 'Note' },
      });
      assert.deepEqual(stored.activity.to, undefined);
      assert.deepEqual(acked, ['privacy-0']);
      for (const leak of [
        'updated secret body',
        '秘密',
        'private CW',
        'private title',
        'private.png',
        'nested secret',
        'nested file',
        'nested.zip',
        'actors/bob',
        'actors/carol',
      ]) {
        assert.equal(row.payload.includes(leak), false, `stored payload leaked ${leak}`);
      }
      assert.equal(envelope, JSON.stringify({ payload: JSON.stringify(original), error: '422 rejected' }));
    } finally {
      db.close();
    }
  });

  it('redacts private Announce and Undo activities with nested object records', async () => {
    const db = createTestDatabase();
    try {
      const bodies = [
        {
          type: 'Announce',
          id: 'https://remote.example/activities/secret-announce',
          actor: 'https://remote.example/actors/alice',
          to: ['https://remote.example/actors/bob'],
          object: {
            id: 'https://remote.example/notes/announced',
            type: 'Note',
            content: 'unlisted announcement body',
            contentMap: { en: 'unlisted announcement body' },
            attachment: [{ type: 'Document', url: 'https://remote.example/media/announced.zip' }],
          },
        },
        {
          type: 'Undo',
          id: 'https://remote.example/activities/secret-undo',
          actor: 'https://remote.example/actors/alice',
          to: ['https://remote.example/actors/bob'],
          object: {
            id: 'https://remote.example/activities/secret-follow',
            type: 'Follow',
            object: {
              id: 'https://remote.example/notes/undone',
              type: 'Note',
              content: 'undone secret body',
              summary: 'undone CW',
              name: 'undone title',
            },
          },
        },
      ];
      const { batch } = dlqBatch(bodies.map((activity) => JSON.stringify({ payload: JSON.stringify(activity) })));

      await queueWorker.queue(batch, fakeEnv(db));

      const announced = await storedRow(db, 'privacy-0');
      const undone = await storedRow(db, 'privacy-1');
      assert.ok(announced);
      assert.ok(undone);
      assert.deepEqual(JSON.parse(announced.payload), {
        type: 'Announce',
        id: 'https://remote.example/activities/secret-announce',
        actor: 'https://remote.example/actors/alice',
        object: { id: 'https://remote.example/notes/announced', type: 'Note' },
      });
      assert.deepEqual(JSON.parse(undone.payload), {
        type: 'Undo',
        id: 'https://remote.example/activities/secret-undo',
        actor: 'https://remote.example/actors/alice',
        object: {
          id: 'https://remote.example/activities/secret-follow',
          type: 'Follow',
          object: { id: 'https://remote.example/notes/undone', type: 'Note' },
        },
      });
      for (const leak of [
        'unlisted announcement body',
        'announced.zip',
        'undone secret body',
        'undone CW',
        'undone title',
        'actors/bob',
      ]) {
        assert.equal(announced.payload.includes(leak) || undone.payload.includes(leak), false, `leaked ${leak}`);
      }
    } finally {
      db.close();
    }
  });

  it('keeps a public Update verbatim so redrive stays useful', async () => {
    const db = createTestDatabase();
    try {
      const original = {
        type: 'Update',
        activity: {
          type: 'Update',
          id: 'https://remote.example/activities/public-update',
          actor: 'https://remote.example/actors/alice',
          to: [PUBLIC_COLLECTION],
          cc: ['https://remote.example/followers/alice'],
          object: {
            id: 'https://remote.example/notes/public-update',
            type: 'Note',
            content: 'already published',
            summary: 'public CW',
            attachment: [{ type: 'Document', url: 'https://remote.example/media/public.zip' }],
            object: { type: 'Note', content: 'nested published body', to: [PUBLIC_COLLECTION] },
          },
        },
      };
      const envelope = JSON.stringify({ payload: JSON.stringify(original), error: null });
      const { batch } = dlqBatch([envelope]);
      await queueWorker.queue(batch, fakeEnv(db));
      const row = await storedRow(db, 'privacy-0');
      assert.ok(row);
      assert.equal(row.payload, JSON.stringify(original));
    } finally {
      db.close();
    }
  });

  it('caps recursion and never stores deeply nested private bodies', async () => {
    const db = createTestDatabase();
    try {
      const deep: Record<string, unknown> = {
        id: 'https://remote.example/notes/deep-25',
        type: 'Note',
        content: 'deep secret',
      };
      for (let i = 0; i < 25; i++) {
        deep.content = 'deep secret';
        deep.object = {
          id: `https://remote.example/notes/deep-${24 - i}`,
          type: 'Note',
          content: 'deep secret',
        };
      }
      const activity = {
        type: 'Create',
        actor: 'https://remote.example/actors/alice',
        to: ['https://remote.example/actors/bob'],
        object: deep,
      };
      const { batch } = dlqBatch([JSON.stringify({ payload: JSON.stringify(activity) })]);
      await queueWorker.queue(batch, fakeEnv(db));
      const row = await storedRow(db, 'privacy-0');
      assert.ok(row);
      assert.equal(row.payload.includes('deep secret'), false, 'deep nesting must not bypass redaction');
      const parsed = JSON.parse(row.payload);
      assert.equal(parsed.object.id, deep.id);
      assert.equal(parsed.object.content, undefined);
    } finally {
      db.close();
    }
  });

  it('does not acknowledge a dead letter when the D1 insert fails', async () => {
    const acked: string[] = [];
    const retried: string[] = [];
    const failingDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async run() {
            throw new Error('D1 database unavailable');
          },
        };
      },
    };
    const message = {
      id: 'db-down',
      attempts: 1,
      timestamp: new Date('2026-01-02T00:00:00.000Z'),
      body: JSON.stringify({ payload: '{}', error: null }),
      ack: () => acked.push('db-down'),
      retry: () => retried.push('db-down'),
    };
    const batch = { queue: AP_DLQ_QUEUE, messages: [message] } as unknown as QueueBatch;

    await queueWorker.queue(batch, fakeEnv(failingDb));

    assert.deepEqual(acked, [], 'a message that was not persisted must not be acknowledged');
    assert.deepEqual(retried, ['db-down'], 'Queues must retry the failed insert');
  });

  it('keeps a public Create with an alias address verbatim', async () => {
    const db = createTestDatabase();
    try {
      const original = {
        ...PUBLIC_ACTIVITY,
        to: ['as:Public'],
        object: { ...PUBLIC_ACTIVITY.object, to: [{ href: 'Public' }] },
      };
      const envelope = JSON.stringify({ payload: JSON.stringify(original), error: '503 peer unavailable' });
      const { batch } = dlqBatch([envelope]);
      await queueWorker.queue(batch, fakeEnv(db));
      const row = await storedRow(db, 'privacy-0');
      assert.ok(row);
      assert.equal(row.payload, JSON.stringify(original));
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
