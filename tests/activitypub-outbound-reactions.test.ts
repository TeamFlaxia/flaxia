// Outbound mapping of Flaxia's Fresh reaction to ActivityPub Like/Undo.
//
// The Hono app is exercised with a fake execution context so the waitUntil
// deliveries can be awaited and inspected on a fake AP_DELIVERY_QUEUE. The
// signed delivery itself is covered by the delivery module tests.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import { PUBLIC_COLLECTION } from '../functions/lib/activitypub/context.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs the same resolver shim the other API tests use.
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

const { engagement } = await import('../functions/api/routes/posts/engagement.ts');

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const REMOTE_BOB = `${REMOTE}/users/bob`;
const REMOTE_CAROL = `${REMOTE}/users/carol`;
const REMOTE_MALLORY = `${REMOTE}/users/mallory`;
const NOW = '2026-01-01T00:00:00.000Z';

type AppEnv = { Bindings: Bindings; Variables: Variables };

interface QueueMessage {
  type: string;
  inboxUrl?: string;
  activity?: Record<string, unknown>;
  senderUsername?: string;
}

const VIEWER: User = {
  id: 'local-1',
  email: 'alice@test.com',
  username: 'alice',
  display_name: 'Alice',
  bio: '',
  created_at: NOW,
};
const AUTHOR: User = {
  id: 'local-2',
  email: 'bob@test.com',
  username: 'bob',
  display_name: 'Bob',
  bio: '',
  created_at: NOW,
};

function appFor(viewer: User): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', viewer);
    await next();
  });
  app.route('/', engagement);
  return app;
}

/** Send an API request and await every task handed to waitUntil. */
async function request(
  app: Hono<AppEnv>,
  path: string,
  env: Bindings,
  body?: Record<string, unknown> | null,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const background: Array<Promise<unknown>> = [];
  const executionCtx = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const init =
    body === null
      ? { method: 'GET' }
      : body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'POST' };
  const response = await app.request(`http://localhost${path}`, init, env, executionCtx);
  await Promise.all(background);
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${path}: HTTP ${response.status} returned ${text.slice(0, 300)}`);
  }
  return { status: response.status, data };
}

async function seed(db: TestDatabase): Promise<void> {
  await seedLocalUser(db, { id: VIEWER.id, username: VIEWER.username, displayName: VIEWER.display_name });
  await seedLocalUser(db, { id: AUTHOR.id, username: AUTHOR.username, displayName: AUTHOR.display_name });
  await seedLocalUser(db, { id: 'local-3', username: 'carol', displayName: 'Carol' });
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, status, visibility, engagement_hotness, created_at)
       VALUES ('federated-post', ?, 'bob', 'a federated note', 'published', 'public', 1.0, ?)`,
    )
    .bind(AUTHOR.id, NOW)
    .run();
  // A local post whose author has no remote followers was never federated.
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, status, visibility, engagement_hotness, created_at)
       VALUES ('local-only-post', 'local-3', 'carol', 'a local note', 'published', 'public', 1.0, ?)`,
    )
    .bind(NOW)
    .run();
}

async function addFollower(
  db: TestDatabase,
  options: { id: string; actorUrl: string; inboxUrl: string; sharedInboxUrl?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, shared_inbox_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(options.id, AUTHOR.id, options.actorUrl, options.inboxUrl, options.sharedInboxUrl ?? null, NOW)
    .run();
}

describe('outbound Fresh reactions as ActivityPub Like', () => {
  let db: TestDatabase;
  let queue: QueueMessage[];
  let api: Bindings;
  let app: Hono<AppEnv>;

  beforeEach(async () => {
    db = createTestDatabase();
    await seed(db);
    queue = [];
    api = {
      DB: db as unknown as Bindings['DB'],
      BASE_URL: BASE,
      AP_DELIVERY_QUEUE: {
        async send(message: QueueMessage) {
          queue.push(message);
        },
      } as unknown as Bindings['AP_DELIVERY_QUEUE'],
    } as Bindings;
    app = appFor(VIEWER);
  });

  afterEach(() => {
    db.close();
  });

  it('sends a Like to the author’s federated followers with the post audience', async () => {
    await addFollower(db, {
      id: 'follower-bob',
      actorUrl: REMOTE_BOB,
      inboxUrl: `${REMOTE_BOB}/inbox`,
      sharedInboxUrl: `${REMOTE}/inbox`,
    });
    await addFollower(db, {
      id: 'follower-carol',
      actorUrl: REMOTE_CAROL,
      inboxUrl: `${REMOTE_CAROL}/inbox`,
      sharedInboxUrl: `${REMOTE}/inbox`,
    });

    const response = await request(app, '/posts/federated-post/fresh', api);
    assert.equal(response.status, 200);
    assert.equal(response.data.freshed, true);

    assert.equal(queue.length, 1, 'one delivery per instance inbox');
    const message = queue[0];
    assert.equal(message.inboxUrl, `${REMOTE}/inbox`);
    assert.equal(message.senderUsername, VIEWER.username);
    const activity = message.activity;
    assert.ok(activity, 'the Like activity must be queued');
    assert.equal(activity.type, 'Like');
    assert.equal(activity.actor, `${BASE}/api/actors/${VIEWER.username}`);
    assert.equal(activity.object, `${BASE}/api/notes/federated-post`);
    assert.ok((activity.to as string[]).includes(PUBLIC_COLLECTION));
    assert.ok(
      (activity.cc as string[]).includes(`${BASE}/api/actors/${AUTHOR.username}/followers`),
      'the Like carries the same audience as the federated Note',
    );
  });

  it('sends Undo(Like) to the same audience when the Fresh is withdrawn', async () => {
    await addFollower(db, {
      id: 'follower-bob',
      actorUrl: REMOTE_BOB,
      inboxUrl: `${REMOTE_BOB}/inbox`,
    });

    await request(app, '/posts/federated-post/fresh', api);
    assert.equal(queue.length, 1);
    queue.length = 0;

    const response = await request(app, '/posts/federated-post/fresh', api);
    assert.equal(response.status, 200);
    assert.equal(response.data.freshed, false);
    assert.equal(queue.length, 1);
    const message = queue[0];
    assert.equal(message.inboxUrl, `${REMOTE_BOB}/inbox`);
    assert.equal(message.activity?.type, 'Undo');
    const undone = message.activity?.object as Record<string, unknown>;
    assert.equal(undone.type, 'Like');
    assert.equal(undone.object, `${BASE}/api/notes/federated-post`);
    assert.equal(undone.actor, `${BASE}/api/actors/${VIEWER.username}`);
  });

  it('does not re-deliver on a repeated add or on unrelated reads', async () => {
    await addFollower(db, {
      id: 'follower-bob',
      actorUrl: REMOTE_BOB,
      inboxUrl: `${REMOTE_BOB}/inbox`,
    });

    await request(app, '/posts/federated-post/fresh', api);
    assert.equal(queue.length, 1);
    queue.length = 0;

    const repeated = await request(app, '/posts/fresh/batch', api, {
      post_ids: ['federated-post'],
      action: 'add',
    });
    assert.deepEqual(repeated.data.freshed, [], 'the post is already Freshed');
    assert.equal(queue.length, 0, 'an already-Freshed post must not produce another Like');

    const reads = await request(app, '/freshs', api, null);
    assert.equal(reads.status, 200);
    assert.equal(queue.length, 0, 'a read must not emit another Like');
  });

  it('skips blocked followers, including a shared inbox used by one', async () => {
    await addFollower(db, {
      id: 'follower-bob',
      actorUrl: REMOTE_BOB,
      inboxUrl: `${REMOTE_BOB}/inbox`,
      sharedInboxUrl: `${REMOTE}/inbox`,
    });
    await addFollower(db, {
      id: 'follower-mallory',
      actorUrl: REMOTE_MALLORY,
      inboxUrl: `${REMOTE_MALLORY}/inbox`,
      sharedInboxUrl: `${REMOTE}/inbox`,
    });
    await db
      .prepare('INSERT INTO ap_blocks (id, local_user_id, actor_url) VALUES (?, ?, ?)')
      .bind('block-mallory', AUTHOR.id, REMOTE_MALLORY)
      .run();

    await request(app, '/posts/federated-post/fresh', api);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].inboxUrl, `${REMOTE_BOB}/inbox`, 'a blocked follower must not receive the Like');
  });

  it('skips a post whose author has no remote followers', async () => {
    const response = await request(app, '/posts/local-only-post/fresh', api);
    assert.equal(response.status, 200);
    assert.equal(response.data.fresh_count, 1);
    assert.equal(queue.length, 0);
  });

  it('sends one Like per inbox for a batch Fresh of a federated local post', async () => {
    await addFollower(db, {
      id: 'follower-bob',
      actorUrl: REMOTE_BOB,
      inboxUrl: `${REMOTE_BOB}/inbox`,
    });
    await addFollower(db, {
      id: 'follower-carol',
      actorUrl: REMOTE_CAROL,
      inboxUrl: `${REMOTE_CAROL}/inbox`,
    });

    const response = await request(app, '/posts/fresh/batch', api, {
      post_ids: ['federated-post', 'local-only-post'],
      action: 'add',
    });
    assert.equal(response.status, 200);
    assert.equal(queue.length, 2);
    assert.deepEqual(queue.map((message) => message.inboxUrl).sort(), [`${REMOTE_BOB}/inbox`, `${REMOTE_CAROL}/inbox`]);
    assert.ok(queue.every((message) => message.activity?.type === 'Like'));
  });
});
