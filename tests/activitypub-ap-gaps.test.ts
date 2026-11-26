import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import queueWorker, { AP_DLQ_QUEUE } from '../functions/queue-worker.ts';
import { activityShape, diffShapes } from './federation/diff.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

type QueueBatch = Parameters<typeof queueWorker.queue>[0];
type QueueEnv = Parameters<typeof queueWorker.queue>[1];

interface BatchStub {
  batch: QueueBatch;
  acked: string[];
  retried: string[];
}

function dlqBatch(bodies: unknown[]): BatchStub {
  const acked: string[] = [];
  const retried: string[] = [];
  const messages = bodies.map((body, index) => {
    const id = `dead-letter-${index}`;
    return {
      id,
      attempts: 1,
      timestamp: new Date('2026-01-02T00:00:00.000Z'),
      body,
      ack: () => acked.push(id),
      retry: () => retried.push(id),
    };
  });
  return {
    batch: { queue: AP_DLQ_QUEUE, messages } as unknown as QueueBatch,
    acked,
    retried,
  };
}

function envFor(db: TestDatabase): QueueEnv {
  return { DB: db as unknown as QueueEnv['DB'], BASE_URL: 'https://flaxia.app' };
}

describe('ActivityPub dead-letter queue consumer', () => {
  let db: TestDatabase;

  before(() => {
    db = createTestDatabase();
  });

  after(() => {
    db.close();
  });

  it('persists the original payload and failure reason, then acknowledges', async () => {
    const payload = JSON.stringify({ type: 'delivery', inboxUrl: 'https://peer.example/inbox' });
    const { batch, acked, retried } = dlqBatch([
      JSON.stringify({ payload, error: '422 rejected by peer' }),
      { type: 'inbox', username: 'alice' },
      'a plain string payload',
    ]);

    await queueWorker.queue(batch, envFor(db));

    const rows = await db
      .prepare('SELECT id, queue, payload, error, received_at FROM ap_dlq ORDER BY id')
      .all<{ id: string; queue: string; payload: string; error: string | null; received_at: string }>();
    assert.deepEqual(
      rows.results.map(({ id, queue, payload: stored, error }) => ({ id, queue, payload: stored, error })),
      [
        { id: 'dead-letter-0', queue: AP_DLQ_QUEUE, payload, error: '422 rejected by peer' },
        {
          id: 'dead-letter-1',
          queue: AP_DLQ_QUEUE,
          payload: JSON.stringify({ type: 'inbox', username: 'alice' }),
          error: null,
        },
        { id: 'dead-letter-2', queue: AP_DLQ_QUEUE, payload: 'a plain string payload', error: null },
      ],
    );
    for (const row of rows.results ?? []) {
      assert.match(row.received_at, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.deepEqual(acked, ['dead-letter-0', 'dead-letter-1', 'dead-letter-2']);
    assert.deepEqual(retried, [], 'a dead letter must never be retried by this consumer');
  });

  it('acknowledges when the ap_dlq table is missing instead of looping', async () => {
    const { batch, acked, retried } = dlqBatch(['{"payload":"{}"}']);
    const missingTable = {
      prepare() {
        throw new Error('no such table: ap_dlq');
      },
    };
    await queueWorker.queue(batch, {
      DB: missingTable as unknown as QueueEnv['DB'],
      BASE_URL: 'https://flaxia.app',
    });
    assert.deepEqual(acked, ['dead-letter-0']);
    assert.deepEqual(retried, []);
  });

  it('leaves the delivery path untouched', async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM ap_dlq').first<{ n: number }>();
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      queue: 'activitypub-delivery',
      messages: [
        {
          id: 'delivery-1',
          attempts: 1,
          timestamp: new Date(),
          body: {
            type: 'delivery',
            inboxUrl: 'http://127.0.0.1/private',
            activity: { type: 'Follow' },
            senderUsername: 'alice',
          },
          ack: () => acked.push('delivery-1'),
          retry: () => retried.push('delivery-1'),
        },
      ],
    } as unknown as QueueBatch;
    await queueWorker.queue(batch, envFor(db));
    const after = await db.prepare('SELECT COUNT(*) AS n FROM ap_dlq').first<{ n: number }>();
    assert.equal(after?.n, before?.n);
    assert.deepEqual(acked, ['delivery-1'], 'an unroutable inbox is still acked, not stored as a dead letter');
    assert.deepEqual(retried, []);
  });
});

describe('Differential activity shapes', () => {
  it('reduces an Undo to the type and target of the retracted activity', () => {
    const shape = activityShape({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://flaxia.app/activities/undo-1',
      type: 'Undo',
      actor: 'https://flaxia.app/api/actors/alice',
      object: {
        id: 'https://remote.example/activities/like-1',
        type: 'Like',
        object: 'https://flaxia.app/api/notes/1',
      },
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    });
    assert.equal(shape.type, 'Undo');
    assert.equal(shape.undoneType, 'Like');
    assert.equal(shape.undoneObjectIsString, true);
    assert.equal(shape.addressedToPublic, true);
    assert.equal(shape.contextIsArray, false);
  });

  it('can ignore the inner object of an Undo but still reports other differences', () => {
    const ours = { type: 'Undo', object: { id: 'ours', type: 'Like' }, hasId: true };
    const theirs = { type: 'Undo', object: { id: 'theirs', type: 'Like' }, hasId: false };
    assert.ok(diffShapes(ours, theirs).some((difference) => difference.field === 'object.id'));
    assert.deepEqual(diffShapes(ours, theirs, { ignore: ['Undo.object'] }), [
      { field: 'hasId', ours: true, theirs: false },
    ]);
  });
});
