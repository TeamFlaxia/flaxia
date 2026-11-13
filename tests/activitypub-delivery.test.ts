import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  collectFollowerInboxes,
  type DeliveryEnv,
  deliverToFollowers,
  deliverToRemoteActor,
} from '../functions/lib/activitypub/delivery.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

const BASE = 'https://flaxia.app';

interface QueueMessage {
  type: string;
  inboxUrl?: string;
  activity?: Record<string, unknown>;
  senderUsername?: string;
}

function envFor(db: TestDatabase, queue: QueueMessage[] = []): DeliveryEnv {
  return {
    DB: db as unknown as DeliveryEnv['DB'],
    BASE_URL: BASE,
    AP_DELIVERY_QUEUE: {
      async send(message: QueueMessage) {
        queue.push(message);
      },
    } as unknown as DeliveryEnv['AP_DELIVERY_QUEUE'],
  };
}

describe('ActivityPub delivery', () => {
  let db: TestDatabase;

  before(async () => {
    db = createTestDatabase();
    await seedLocalUser(db, { id: 'local-1', username: 'alice' });
  });

  after(() => {
    db.close();
  });

  it('sends one delivery per inbox, not per follower', async () => {
    await db
      .prepare(
        `INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, shared_inbox_url, created_at)
         VALUES ('f-1', 'local-1', 'https://a.example/users/a', 'https://a.example/users/a/inbox', 'https://a.example/inbox', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, shared_inbox_url, created_at)
         VALUES ('f-2', 'local-1', 'https://a.example/users/b', 'https://a.example/users/b/inbox', 'https://a.example/inbox', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, shared_inbox_url, created_at)
         VALUES ('f-3', 'local-1', 'https://b.example/users/c', 'https://b.example/users/c/inbox', NULL, '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const inboxes = await collectFollowerInboxes(envFor(db), 'local-1');
    assert.deepEqual(inboxes.sort(), ['https://a.example/inbox', 'https://b.example/users/c/inbox']);

    const queue: QueueMessage[] = [];
    const delivered = await deliverToFollowers(envFor(db, queue), {
      userId: 'local-1',
      username: 'alice',
      activity: { type: 'Create' },
    });
    assert.equal(delivered, 2);
    assert.equal(queue.length, 2);
    assert.deepEqual(queue.map((message) => message.inboxUrl).sort(), [
      'https://a.example/inbox',
      'https://b.example/users/c/inbox',
    ]);
    assert.equal(queue[0].senderUsername, 'alice');
  });

  it('delivers to the shared inbox of a remote account we follow', async () => {
    await db
      .prepare(
        `INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, shared_inbox_url, status, created_at)
         VALUES ('following-1', 'local-1', 'https://remote.example/users/alice', 'https://remote.example/users/alice/inbox', 'https://remote.example/inbox', 'accepted', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const queue: QueueMessage[] = [];
    await deliverToRemoteActor(envFor(db, queue), {
      actorUrl: 'https://remote.example/users/alice',
      username: 'alice',
      activity: { type: 'Like' },
    });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].inboxUrl, 'https://remote.example/inbox');
  });

  it('does not deliver to an account we do not follow', async () => {
    const queue: QueueMessage[] = [];
    await deliverToRemoteActor(envFor(db, queue), {
      actorUrl: 'https://unknown.example/users/x',
      username: 'alice',
      activity: { type: 'Like' },
    });
    assert.equal(queue.length, 0);
  });
});
