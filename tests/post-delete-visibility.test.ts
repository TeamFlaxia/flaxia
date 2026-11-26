// A Delete must never be addressed more widely than the Create it retracts.
// In particular, deleting a direct/private post must not announce a
// Public-addressed Tombstone naming /api/notes/<id> to every remote follower.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import { PUBLIC_COLLECTION } from '../functions/lib/activitypub/context.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// The shared test adapter's `all()` has no `success` flag, while some route
// helpers check it exactly like real D1.
type TestStatement = ReturnType<TestDatabase['prepare']>;

function wrapStatement(statement: TestStatement): TestStatement {
  return {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
    first: <T>() => statement.first<T>(),
    all: async <T>() => ({ ...(await statement.all<T>()), success: true }) as { results: T[] },
    run: () => statement.run(),
  };
}

function wrapDb(database: TestDatabase): TestDatabase {
  return {
    prepare: (sql: string) => wrapStatement(database.prepare(sql)),
    batch: (statements: TestStatement[]) => database.batch(statements),
    exec: (sql: string) => database.exec(sql),
    close: () => database.close(),
  };
}

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs a resolver shim to load the same modules for behavioural tests
// (same pattern as tests/post-visibility.test.ts).
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
}
`),
);

const { manage } = await import('../functions/api/routes/posts/manage.ts');

type AppEnv = { Bindings: Bindings; Variables: Variables };

const BASE = 'https://flaxia.app';
const NOW = '2026-11-26T00:00:00.000Z';
const FOLLOWERS_URL = `${BASE}/api/actors/alice/followers`;
const ALICE: User = {
  id: 'alice',
  email: 'alice@test.com',
  username: 'alice',
  display_name: 'Alice',
  bio: '',
  created_at: NOW,
};

// Two remote followers: one personal inbox, one instance shared inbox.
const F1_ACTOR = 'https://remote.example/users/follower1';
const F1_INBOX = `${F1_ACTOR}/inbox`;
const F2_ACTOR = 'https://other.example/users/follower2';
const F2_INBOX = `${F2_ACTOR}/inbox`;
const F2_SHARED_INBOX = 'https://other.example/inbox';
const FOLLOWER_INBOXES = [F1_INBOX, F2_SHARED_INBOX].sort();

// A mentioned remote actor that is NOT a follower of Alice. Only this actor
// may receive the Delete of a direct post.
const BOB_ACTOR = 'https://remote.example/users/bob';
const BOB_INBOX = `${BOB_ACTOR}/inbox`;

interface QueueMessage {
  type: string;
  inboxUrl?: string;
  activity?: Record<string, unknown>;
  senderUsername?: string;
}

function envFor(database: TestDatabase, queue: QueueMessage[]): Bindings {
  return {
    DB: wrapDb(database) as unknown as Bindings['DB'],
    BASE_URL: BASE,
    AP_DELIVERY_QUEUE: {
      async send(message: QueueMessage) {
        queue.push(message);
      },
    } as unknown as Bindings['AP_DELIVERY_QUEUE'],
  } as Bindings;
}

function appFor(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', ALICE);
    await next();
  });
  app.route('/', manage);
  return app;
}

async function seedActor(db: TestDatabase, actorUrl: string, inboxUrl: string, sharedInboxUrl: string | null) {
  await db
    .prepare(
      `INSERT INTO ap_actors (actor_url, inbox_url, shared_inbox_url, preferred_username, display_name, domain)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(actorUrl, inboxUrl, sharedInboxUrl, actorUrl.split('/').pop(), actorUrl.split('/').pop(), 'remote.example')
    .run();
}

const databases: TestDatabase[] = [];
let db: TestDatabase;

beforeEach(async () => {
  db = createTestDatabase();
  databases.push(db);
  // 0002 seeds demo posts; keep the fixture isolated from them.
  db.prepare('DELETE FROM posts').run();
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
    .bind(ALICE.id, ALICE.email, ALICE.username, ALICE.display_name, NOW)
    .run();

  for (const [actor, inbox, shared] of [
    [F1_ACTOR, F1_INBOX, null],
    [F2_ACTOR, F2_INBOX, F2_SHARED_INBOX],
    [BOB_ACTOR, BOB_INBOX, null],
  ] as const) {
    await seedActor(db, actor, inbox, shared);
  }
  for (const [actor, inbox, shared] of [
    [F1_ACTOR, F1_INBOX, null],
    [F2_ACTOR, F2_INBOX, F2_SHARED_INBOX],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO ap_followers (actor_url, local_user_id, inbox_url, shared_inbox_url)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(actor, ALICE.id, inbox, shared)
      .run();
  }

  await seedPost('public-post', 'public', '[]');
  await seedPost('private-post', 'private', '[]');
  await seedPost(
    'direct-post',
    'direct',
    JSON.stringify([{ username: 'bob', domain: 'remote.example', url: BOB_ACTOR }]),
  );
});

after(() => {
  for (const database of databases) database.close();
});

async function seedPost(id: string, visibility: string, mentions: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, status, visibility, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, 'published', ?, ?)`,
    )
    .bind(id, ALICE.id, ALICE.username, `hello ${id}`, mentions, visibility, NOW)
    .run();
}

async function deleteAndCapture(
  postId: string,
): Promise<Array<{ inboxUrl?: string; activity?: Record<string, unknown> }>> {
  const queue: QueueMessage[] = [];
  const response = await appFor().request(`http://localhost/posts/${postId}`, { method: 'DELETE' }, envFor(db, queue));
  assert.equal(response.status, 200, `DELETE ${postId} → ${response.status}: ${await response.clone().text()}`);
  assert.deepEqual(await response.json(), { success: true });
  return queue.filter((message) => message.type === 'delivery');
}

function inboxesOf(deliveries: Array<{ inboxUrl?: string }>): string[] {
  return [...new Set(deliveries.map((delivery) => delivery.inboxUrl).filter((url): url is string => !!url))].sort();
}

function audiencesOf(
  deliveries: Array<{ activity?: Record<string, unknown> }>,
): Array<{ to: unknown; cc: unknown; objectId: unknown }> {
  return deliveries.map((delivery) => {
    const activity = delivery.activity;
    assert.ok(activity, 'each delivery must carry an ActivityPub activity');
    const object = activity.object as { id?: unknown } | undefined;
    return { to: activity.to, cc: activity.cc, objectId: object?.id };
  });
}

describe('DELETE federation respects the original post visibility', () => {
  it('public post: Delete stays Public-addressed and reaches every follower inbox', async () => {
    const deliveries = await deleteAndCapture('public-post');

    assert.deepEqual(inboxesOf(deliveries), FOLLOWER_INBOXES);
    assert.equal(deliveries.length, 2, 'exactly one delivery per follower inbox');
    assert.deepEqual(audiencesOf(deliveries), [
      { to: [PUBLIC_COLLECTION], cc: [FOLLOWERS_URL], objectId: `${BASE}/api/notes/public-post` },
      { to: [PUBLIC_COLLECTION], cc: [FOLLOWERS_URL], objectId: `${BASE}/api/notes/public-post` },
    ]);
  });

  it('private post: Delete is followers-only, never Public-addressed', async () => {
    const deliveries = await deleteAndCapture('private-post');

    assert.deepEqual(inboxesOf(deliveries), FOLLOWER_INBOXES);
    assert.equal(deliveries.length, 2, 'exactly one delivery per follower inbox');
    assert.deepEqual(audiencesOf(deliveries), [
      { to: [FOLLOWERS_URL], cc: [], objectId: `${BASE}/api/notes/private-post` },
      { to: [FOLLOWERS_URL], cc: [], objectId: `${BASE}/api/notes/private-post` },
    ]);
  });

  it('direct post: Delete goes only to the mentioned actor, never to followers', async () => {
    const deliveries = await deleteAndCapture('direct-post');

    assert.deepEqual(inboxesOf(deliveries), [BOB_INBOX]);
    assert.equal(deliveries.length, 1, 'exactly one delivery, to the mentioned actor');
    assert.deepEqual(audiencesOf(deliveries), [{ to: [BOB_ACTOR], cc: [], objectId: `${BASE}/api/notes/direct-post` }]);
  });
});
