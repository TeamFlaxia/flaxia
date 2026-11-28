// Bidirectional visibility of Fresh (Like) and Reload (Announce).
//
// Inbound activities are fed through handleIncomingActivity with a real D1
// schema (tests/helpers/d1.ts); outbound routes are exercised through Hono
// with a fake execution context, so the waitUntil deliveries can be awaited
// and inspected through a fake AP_DELIVERY_QUEUE.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { HandlerEnv } from '../functions/lib/activitypub/handlers.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

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

const { engagement } = await import('../functions/api/routes/posts/engagement.ts');
const { handleIncomingActivity } = await import('../functions/lib/activitypub/handlers.ts');

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const REMOTE_ALICE = `${REMOTE}/users/alice`;
const REMOTE_BOB = `${REMOTE}/users/bob`;
const REMOTE_MALLORY = `${REMOTE}/users/mallory`;
const ALICE_NOTE = `${REMOTE}/notes/alice-1`;
const BOB_NOTE = `${REMOTE}/notes/bob-1`;
const NOW = '2026-01-01T00:00:00.000Z';

type AppEnv = { Bindings: Bindings; Variables: Variables };
type Counters = { fresh_count: number; engagement_hotness: number };

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

function envsFor(db: TestDatabase, queue: QueueMessage[]): { api: Bindings; handler: HandlerEnv } {
  const queueBinding = {
    async send(message: QueueMessage) {
      queue.push(message);
    },
  };
  const api = {
    DB: db as unknown as Bindings['DB'],
    BASE_URL: BASE,
    AP_DELIVERY_QUEUE: queueBinding as unknown as Bindings['AP_DELIVERY_QUEUE'],
  } as Bindings;
  const handler: HandlerEnv = {
    DB: db as unknown as HandlerEnv['DB'],
    BASE_URL: BASE,
    AP_DELIVERY_QUEUE: queueBinding as unknown as HandlerEnv['AP_DELIVERY_QUEUE'],
  };
  return { api, handler };
}

function appFor(viewer: User): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', viewer);
    await next();
  });
  app.route('/', engagement);
  return app;
}

type CapturedPush = { userId: string; body: string };

/** Record the exact push payload a recipient would receive through the fake DO. */
function apiWithPushCapture(api: Bindings, pushes: CapturedPush[]): Bindings {
  const notificationStream = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (_url: string, init?: RequestInit) => {
        const message = JSON.parse(String(init?.body)) as { push?: { body?: string } };
        if (message.push?.body) pushes.push({ userId: id, body: message.push.body });
        return new Response(null, { status: 204 });
      },
    }),
  };
  return { ...api, NOTIFICATION_STREAM: notificationStream } as unknown as Bindings;
}

/** Send an API request and await every task handed to waitUntil. */
async function post(
  app: Hono<AppEnv>,
  path: string,
  body: Record<string, unknown> | null,
  env: Bindings,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const background: Array<Promise<unknown>> = [];
  const executionCtx = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const response = await app.request(
    `http://localhost${path}`,
    body === null
      ? { method: 'POST' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    executionCtx,
  );
  await Promise.all(background);
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function seed(db: TestDatabase): Promise<void> {
  await seedLocalUser(db, { id: 'local-1', username: 'alice', displayName: 'Alice' });
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, status, engagement_hotness, created_at)
       VALUES ('local-post', 'local-1', 'alice', 'local note', '[]', 'published', 1.0, ?)`,
    )
    .bind(NOW)
    .run();
  // Mirrored remote posts: user_id is empty, the original author lives in
  // actor_id and the note keeps its remote object id.
  for (const [id, actor, note] of [
    ['remote-post', REMOTE_ALICE, ALICE_NOTE],
    ['remote-post-2', REMOTE_BOB, BOB_NOTE],
  ]) {
    await db
      .prepare(
        `INSERT INTO posts (id, user_id, username, text, hashtags, status, actor_id, ap_object_id, engagement_hotness, created_at)
         VALUES (?, '', ?, 'remote note', '[]', 'published', ?, ?, 1.0, ?)`,
      )
      .bind(id, actor.split('/').pop(), actor, note, NOW)
      .run();
    await db
      .prepare('INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, domain) VALUES (?, ?, ?, ?)')
      .bind(actor, `${actor}/inbox`, actor.split('/').pop(), 'remote.example')
      .run();
  }
}

/** Insert a post with an explicit audience, optionally mirroring a remote note. */
async function seedPost(
  db: TestDatabase,
  options: {
    id: string;
    userId: string;
    username: string;
    visibility: string;
    text: string;
    mentions?: string;
    actorId?: string | null;
    objectId?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, status, visibility, actor_id, ap_object_id, engagement_hotness, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, 'published', ?, ?, ?, 1.0, ?)`,
    )
    .bind(
      options.id,
      options.userId,
      options.username,
      options.text,
      options.mentions ?? '[]',
      options.visibility,
      options.actorId ?? null,
      options.objectId ?? null,
      NOW,
    )
    .run();
}

async function countersFor(db: TestDatabase, postId: string): Promise<Counters> {
  const row = await db
    .prepare('SELECT fresh_count, engagement_hotness FROM posts WHERE id = ?')
    .bind(postId)
    .first<Counters>();
  assert.ok(row, `post ${postId} must exist`);
  return { fresh_count: row.fresh_count, engagement_hotness: Number(row.engagement_hotness) };
}

async function count(db: TestDatabase, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function sendLike(db: TestDatabase, activityId: string, object: string, actor = REMOTE_ALICE): Promise<void> {
  await handleIncomingActivity(envsFor(db, []).handler, {
    actorId: actor,
    username: 'alice',
    activity: { id: `${REMOTE}/activities/${activityId}`, type: 'Like', actor, object },
  });
}

describe('inbound Like and Undo keep the public Fresh counter in sync', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = createTestDatabase();
    await seed(db);
  });

  afterEach(() => {
    db.close();
  });

  it('increments fresh_count/hotness exactly once and ignores replays', async () => {
    const note = `${BASE}/api/notes/local-post`;
    await sendLike(db, 'like-1', note);

    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });
    assert.equal(
      await count(db, 'SELECT COUNT(*) AS n FROM likes WHERE post_id = ? AND actor_id = ?', 'local-post', REMOTE_ALICE),
      1,
    );
    assert.equal(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM notifications WHERE type = 'ap_like' AND post_id = ? AND actor_id = ?",
        'local-post',
        REMOTE_ALICE,
      ),
      1,
    );

    // A retry with a new activity id reaches handleLike, but INSERT OR IGNORE
    // on (post_id, actor_id) must not bump the counters or add a notification.
    await sendLike(db, 'like-1-retry', note);
    // The identical activity id is claimed already and skipped even earlier.
    await sendLike(db, 'like-1', note);

    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });
    assert.equal(
      await count(db, 'SELECT COUNT(*) AS n FROM likes WHERE post_id = ? AND actor_id = ?', 'local-post', REMOTE_ALICE),
      1,
    );
    assert.equal(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM notifications WHERE type = 'ap_like' AND post_id = ? AND actor_id = ?",
        'local-post',
        REMOTE_ALICE,
      ),
      1,
    );
  });

  it('increments only once when duplicate Likes arrive concurrently', async () => {
    const note = `${BASE}/api/notes/local-post`;
    // A retried delivery races the original: every copy has a distinct
    // activity id, so only the (post_id, actor_id) uniqueness can protect the
    // public counter and notification.
    await Promise.all(Array.from({ length: 8 }, (_, index) => sendLike(db, `like-concurrent-${index}`, note)));

    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });
    assert.equal(
      await count(db, 'SELECT COUNT(*) AS n FROM likes WHERE post_id = ? AND actor_id = ?', 'local-post', REMOTE_ALICE),
      1,
    );
    assert.equal(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM notifications WHERE type = 'ap_like' AND post_id = ? AND actor_id = ?",
        'local-post',
        REMOTE_ALICE,
      ),
      1,
    );
  });

  it('decrements only once when duplicate Undo activities arrive concurrently', async () => {
    const note = `${BASE}/api/notes/local-post`;
    await sendLike(db, 'like-before-concurrent-undo', note);
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });

    const handler = envsFor(db, []).handler;
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        handleIncomingActivity(handler, {
          actorId: REMOTE_ALICE,
          username: 'alice',
          activity: {
            id: `${REMOTE}/activities/undo-concurrent-${index}`,
            type: 'Undo',
            actor: REMOTE_ALICE,
            object: {
              id: `${REMOTE}/activities/like-before-concurrent-undo`,
              type: 'Like',
              actor: REMOTE_ALICE,
              object: note,
            },
          },
        }),
      ),
    );

    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 0, engagement_hotness: 1 });
    assert.equal(
      await count(db, 'SELECT COUNT(*) AS n FROM likes WHERE post_id = ? AND actor_id = ?', 'local-post', REMOTE_ALICE),
      0,
    );
    assert.equal(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM notifications WHERE type = 'ap_like' AND post_id = ? AND actor_id = ?",
        'local-post',
        REMOTE_ALICE,
      ),
      0,
    );
  });

  it('decrements on Undo from the signing actor but rejects a different actor', async () => {
    const note = `${BASE}/api/notes/local-post`;
    await sendLike(db, 'like-2', note);
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });

    // Mallory signs an Undo that only claims to retract Alice's Like. Even if
    // the outer actor guard passes, the DELETE is bound to the signing actor
    // and therefore cannot remove Alice's row or the counters.
    const handler = envsFor(db, []).handler;
    await handleIncomingActivity(handler, {
      actorId: REMOTE_MALLORY,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/undo-forged`,
        type: 'Undo',
        actor: REMOTE_MALLORY,
        object: { id: `${REMOTE}/activities/like-2`, type: 'Like', actor: REMOTE_MALLORY, object: note },
      },
    });
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });

    // A mismatch between the signer and the activity actor is rejected before
    // any delete happens.
    await handleIncomingActivity(handler, {
      actorId: REMOTE_MALLORY,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/undo-mismatch`,
        type: 'Undo',
        actor: REMOTE_ALICE,
        object: { id: `${REMOTE}/activities/like-2`, type: 'Like', actor: REMOTE_ALICE, object: note },
      },
    });
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });

    await handleIncomingActivity(handler, {
      actorId: REMOTE_ALICE,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/undo-real`,
        type: 'Undo',
        actor: REMOTE_ALICE,
        object: { id: `${REMOTE}/activities/like-2`, type: 'Like', actor: REMOTE_ALICE, object: note },
      },
    });
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 0, engagement_hotness: 1 });
    assert.equal(
      await count(db, 'SELECT COUNT(*) AS n FROM likes WHERE post_id = ? AND actor_id = ?', 'local-post', REMOTE_ALICE),
      0,
    );
    assert.equal(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM notifications WHERE type = 'ap_like' AND post_id = ? AND actor_id = ?",
        'local-post',
        REMOTE_ALICE,
      ),
      0,
    );

    // A repeated Undo only touches counters when a Like row was deleted.
    await handleIncomingActivity(handler, {
      actorId: REMOTE_ALICE,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/undo-repeat`,
        type: 'Undo',
        actor: REMOTE_ALICE,
        object: { id: `${REMOTE}/activities/like-2`, type: 'Like', actor: REMOTE_ALICE, object: note },
      },
    });
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 0, engagement_hotness: 1 });
  });

  it('resolves a Like of a mirrored remote post by its ap_object_id', async () => {
    await sendLike(db, 'like-remote', ALICE_NOTE);
    assert.deepEqual(await countersFor(db, 'remote-post'), { fresh_count: 1, engagement_hotness: 3 });
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 0, engagement_hotness: 1 });
  });
});

describe('outbound Fresh and Reload federation', () => {
  let db: TestDatabase;
  let queue: QueueMessage[];
  let api: Bindings;
  let app: Hono<AppEnv>;

  beforeEach(async () => {
    db = createTestDatabase();
    await seed(db);
    queue = [];
    ({ api } = envsFor(db, queue));
    app = appFor(VIEWER);
  });

  afterEach(() => {
    db.close();
  });

  it('returns 404 for bookmarks and reactions on posts the viewer cannot read', async () => {
    await seedLocalUser(db, { id: 'local-2', username: 'bob', displayName: 'Bob' });
    for (const [id, author, visibility, mentions] of [
      ['secret-private', 'local-2', 'private', '[]'],
      ['secret-direct', 'local-2', 'direct', JSON.stringify([{ username: 'carol', user_id: 'local-3' }])],
      ['own-private', VIEWER.id, 'private', '[]'],
    ]) {
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, status, visibility, created_at)
           VALUES (?, ?, 'bob', ?, '[]', ?, 'published', ?, ?)`,
        )
        .bind(id, author, `note ${id}`, mentions, visibility, NOW)
        .run();
    }

    for (const path of [
      '/posts/secret-private/bookmark',
      '/posts/secret-direct/bookmark',
      '/posts/secret-private/reactions',
      '/posts/secret-direct/reactions',
    ]) {
      const response = await post(app, path, path.endsWith('reactions') ? { emoji: '🔥' } : {}, api);
      assert.equal(response.status, 404, `${path}: ${JSON.stringify(response.data)}`);
      assert.deepEqual(response.data, { error: 'Post not found' });
    }
    assert.equal(
      await count(db, 'SELECT COUNT(*) AS n FROM bookmarks WHERE post_id IN (?, ?)', 'secret-private', 'secret-direct'),
      0,
    );
    assert.equal(
      await count(db, 'SELECT COUNT(*) AS n FROM reactions WHERE post_id IN (?, ?)', 'secret-private', 'secret-direct'),
      0,
    );

    // The author and an ordinary public post remain fully usable.
    const ownBookmark = await post(app, '/posts/own-private/bookmark', {}, api);
    assert.equal(ownBookmark.status, 200);
    const ownReaction = await post(app, '/posts/own-private/reactions', { emoji: '🔥' }, api);
    assert.equal(ownReaction.status, 200);
    const publicReaction = await post(app, '/posts/local-post/reactions', { emoji: '🔥' }, api);
    assert.equal(publicReaction.status, 200);
  });

  it('keeps the existing single Fresh flow for local posts', async () => {
    const first = await post(app, '/posts/local-post/fresh', null, api);
    assert.equal(first.status, 200);
    assert.equal(first.data.freshed, true);
    assert.equal(first.data.fresh_count, 1);
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });
    assert.equal(
      await count(db, 'SELECT COUNT(*) AS n FROM freshs WHERE post_id = ? AND user_id = ?', 'local-post', 'local-1'),
      1,
    );
    assert.equal(queue.length, 0, 'a local post has no remote inbox to receive a Like');

    const second = await post(app, '/posts/local-post/fresh', null, api);
    assert.equal(second.status, 200);
    assert.equal(second.data.freshed, false);
    assert.equal(second.data.fresh_count, 0);
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 0, engagement_hotness: 1 });
  });

  it('delivers a single Fresh Like/Undo with the remote ap_object_id', async () => {
    const first = await post(app, '/posts/remote-post/fresh', null, api);
    assert.equal(first.status, 200);
    assert.equal(first.data.freshed, true);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].inboxUrl, `${REMOTE_ALICE}/inbox`);
    assert.equal(queue[0].senderUsername, 'alice');
    assert.equal(queue[0].activity?.type, 'Like');
    assert.equal(queue[0].activity?.object, ALICE_NOTE);

    queue.length = 0;
    const second = await post(app, '/posts/remote-post/fresh', null, api);
    assert.equal(second.status, 200);
    assert.equal(second.data.freshed, false);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].inboxUrl, `${REMOTE_ALICE}/inbox`);
    assert.equal(queue[0].activity?.type, 'Undo');
    const undone = queue[0].activity?.object as Record<string, unknown> | undefined;
    assert.equal(undone?.type, 'Like');
    assert.equal(undone?.object, ALICE_NOTE);
  });

  it('federates one Like per remote post on batch Fresh', async () => {
    const response = await post(
      app,
      '/posts/fresh/batch',
      { post_ids: ['remote-post', 'remote-post-2', 'local-post'], action: 'add' },
      api,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.freshed, ['remote-post', 'remote-post-2', 'local-post']);

    assert.equal(queue.length, 2, 'one Like per remote post, none for the local post');
    const byInbox = new Map(queue.map((message) => [message.inboxUrl, message]));
    assert.equal(byInbox.get(`${REMOTE_ALICE}/inbox`)?.activity?.object, ALICE_NOTE);
    assert.equal(byInbox.get(`${REMOTE_BOB}/inbox`)?.activity?.object, BOB_NOTE);
    assert.ok([...byInbox.values()].every((message) => message.activity?.type === 'Like'));

    assert.deepEqual(await countersFor(db, 'remote-post'), { fresh_count: 1, engagement_hotness: 3 });
    assert.deepEqual(await countersFor(db, 'remote-post-2'), { fresh_count: 1, engagement_hotness: 3 });
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 1, engagement_hotness: 3 });
  });

  it('federates Undo(Like) per remote post on batch un-Fresh', async () => {
    await post(
      app,
      '/posts/fresh/batch',
      { post_ids: ['remote-post', 'remote-post-2', 'local-post'], action: 'add' },
      api,
    );
    queue.length = 0;

    const response = await post(
      app,
      '/posts/fresh/batch',
      { post_ids: ['remote-post', 'remote-post-2', 'local-post'], action: 'remove' },
      api,
    );
    assert.equal(response.status, 200);
    assert.equal(queue.length, 2);
    const byInbox = new Map(queue.map((message) => [message.inboxUrl, message]));
    for (const [inbox, note] of [
      [`${REMOTE_ALICE}/inbox`, ALICE_NOTE],
      [`${REMOTE_BOB}/inbox`, BOB_NOTE],
    ]) {
      const message = byInbox.get(inbox);
      assert.ok(message, `Undo must reach ${inbox}`);
      assert.equal(message.activity?.type, 'Undo');
      const undone = message.activity?.object as Record<string, unknown> | undefined;
      assert.equal(undone?.type, 'Like');
      assert.equal(undone?.object, note);
    }
    assert.deepEqual(await countersFor(db, 'remote-post'), { fresh_count: 0, engagement_hotness: 1 });
    assert.deepEqual(await countersFor(db, 'local-post'), { fresh_count: 0, engagement_hotness: 1 });
  });

  it('sends an Announce to the remote author and Undo on Reload/undo', async () => {
    const first = await post(app, '/posts/remote-post/reload', null, api);
    assert.equal(first.status, 200);
    assert.equal(first.data.reloaded, true);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].inboxUrl, `${REMOTE_ALICE}/inbox`);
    assert.equal(queue[0].activity?.type, 'Announce');
    assert.equal(queue[0].activity?.object, ALICE_NOTE);

    queue.length = 0;
    const second = await post(app, '/posts/remote-post/reload', null, api);
    assert.equal(second.status, 200);
    assert.equal(second.data.reloaded, false);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].inboxUrl, `${REMOTE_ALICE}/inbox`);
    assert.equal(queue[0].activity?.type, 'Undo');
    const undone = queue[0].activity?.object as Record<string, unknown> | undefined;
    assert.equal(undone?.type, 'Announce');
    assert.equal(undone?.object, ALICE_NOTE);
  });

  it('sends an Announce of a local post to the reloader’s followers', async () => {
    await db
      .prepare(
        `INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, created_at)
         VALUES ('follower-1', 'local-1', ?, ?, ?)`,
      )
      .bind(REMOTE_BOB, `${REMOTE_BOB}/inbox`, NOW)
      .run();

    const response = await post(app, '/posts/local-post/reload', null, api);
    assert.equal(response.status, 200);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].inboxUrl, `${REMOTE_BOB}/inbox`);
    assert.equal(queue[0].activity?.type, 'Announce');
    assert.equal(queue[0].activity?.object, `${BASE}/api/notes/local-post`);
  });

  it('404s fresh, batch fresh and reload for private/direct posts the viewer cannot read', async () => {
    await seedLocalUser(db, { id: 'local-2', username: 'bob', displayName: 'Bob' });
    const hidden: Array<{
      id: string;
      visibility: string;
      mentions?: string;
      actorId?: string;
    }> = [
      { id: 'hidden-private', visibility: 'private' },
      { id: 'hidden-direct', visibility: 'direct', mentions: JSON.stringify([{ user_id: 'local-3' }]) },
      { id: 'hidden-remote-private', visibility: 'private', actorId: REMOTE_ALICE },
      {
        id: 'hidden-remote-direct',
        visibility: 'direct',
        mentions: JSON.stringify([{ user_id: 'local-3' }]),
        actorId: REMOTE_BOB,
      },
    ];
    for (const postInfo of hidden) {
      await seedPost(db, {
        id: postInfo.id,
        userId: postInfo.actorId ? '' : 'local-2',
        username: 'bob',
        visibility: postInfo.visibility,
        mentions: postInfo.mentions,
        text: `secret ${postInfo.id}`,
        actorId: postInfo.actorId,
        objectId: postInfo.actorId ? `${REMOTE}/notes/${postInfo.id}` : null,
      });
    }

    const pushes: CapturedPush[] = [];
    const pushApi = apiWithPushCapture(api, pushes);
    for (const { id } of hidden) {
      const fresh = await post(app, `/posts/${id}/fresh`, null, pushApi);
      assert.equal(fresh.status, 404, `${id} fresh: ${JSON.stringify(fresh.data)}`);
      assert.deepEqual(fresh.data, { error: 'Post not found' });

      const batch = await post(app, '/posts/fresh/batch', { post_ids: [id], action: 'add' }, pushApi);
      assert.equal(batch.status, 404, `${id} batch fresh: ${JSON.stringify(batch.data)}`);
      assert.deepEqual(batch.data.error, 'Some posts not found');

      const reload = await post(app, `/posts/${id}/reload`, null, pushApi);
      assert.equal(reload.status, 404, `${id} reload: ${JSON.stringify(reload.data)}`);
      assert.deepEqual(reload.data, { error: 'Post not found' });
    }

    // A mixed batch must reject the whole request instead of quietly
    // freshening the post the caller is allowed to see.
    const mixed = await post(
      app,
      '/posts/fresh/batch',
      { post_ids: ['local-post', 'hidden-private'], action: 'add' },
      pushApi,
    );
    assert.equal(mixed.status, 404);
    assert.deepEqual(mixed.data.invalid_ids, ['hidden-private']);

    for (const { id } of hidden) {
      assert.deepEqual(await countersFor(db, id), { fresh_count: 0, engagement_hotness: 1 });
    }
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM freshs'), 0);
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM shares'), 0);
    assert.equal(queue.length, 0);
    assert.equal(pushes.length, 0);
  });

  it('does not federate or push the text of readable private/direct posts', async () => {
    await seedLocalUser(db, { id: 'local-2', username: 'bob', displayName: 'Bob' });
    const viewerMention = JSON.stringify([{ username: 'alice', user_id: VIEWER.id }]);
    await seedPost(db, {
      id: 'own-private',
      userId: VIEWER.id,
      username: 'alice',
      visibility: 'private',
      text: 'OWN PRIVATE SECRET',
    });
    await seedPost(db, {
      id: 'direct-to-alice',
      userId: 'local-2',
      username: 'bob',
      visibility: 'direct',
      mentions: viewerMention,
      text: 'DIRECT PRIVATE SECRET',
    });
    await seedPost(db, {
      id: 'remote-direct',
      userId: '',
      username: 'alice',
      visibility: 'direct',
      mentions: viewerMention,
      text: 'REMOTE DIRECT SECRET',
      actorId: REMOTE_ALICE,
      objectId: `${REMOTE}/notes/remote-direct`,
    });
    // A local reload would otherwise announce to this follower: restricted
    // posts must not be broadcast even when the viewer may read them.
    await db
      .prepare(
        `INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, created_at)
         VALUES ('follower-1', ?, ?, ?, ?)`,
      )
      .bind(VIEWER.id, REMOTE_BOB, `${REMOTE_BOB}/inbox`, NOW)
      .run();

    const pushes: CapturedPush[] = [];
    const pushApi = apiWithPushCapture(api, pushes);
    const secrets = ['OWN PRIVATE SECRET', 'DIRECT PRIVATE SECRET', 'REMOTE DIRECT SECRET'];
    const ids = ['own-private', 'direct-to-alice', 'remote-direct'];

    // Add and remove every engagement so Like/Undo and Announce/Undo paths
    // are both exercised.
    for (const id of ids) {
      for (const path of [`/posts/${id}/fresh`, `/posts/${id}/fresh`, `/posts/${id}/reload`, `/posts/${id}/reload`]) {
        const response = await post(app, path, null, pushApi);
        assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.data)}`);
      }
    }
    const batchIds = ['direct-to-alice', 'remote-direct'];
    for (const action of ['add', 'remove']) {
      const response = await post(app, '/posts/fresh/batch', { post_ids: batchIds, action }, pushApi);
      assert.equal(response.status, 200, `${action}: ${JSON.stringify(response.data)}`);
    }

    assert.equal(queue.length, 0, 'no Like/Undo or Announce/Undo may leave the instance');
    assert.ok(
      pushes.every(({ body }) => secrets.every((secret) => !body.includes(secret))),
      `push body leaked restricted text: ${JSON.stringify(pushes)}`,
    );
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM freshs'), 0);
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM shares'), 0);
  });

  it('keeps federation and push text for public/unlisted posts', async () => {
    await seedLocalUser(db, { id: 'local-2', username: 'bob', displayName: 'Bob' });
    await seedPost(db, {
      id: 'public-local',
      userId: 'local-2',
      username: 'bob',
      visibility: 'public',
      text: 'PUBLIC BODY',
    });
    await seedPost(db, {
      id: 'unlisted-remote',
      userId: '',
      username: 'alice',
      visibility: 'unlisted',
      text: 'UNLISTED BODY',
      actorId: REMOTE_BOB,
      objectId: `${REMOTE}/notes/unlisted-remote`,
    });

    const pushes: CapturedPush[] = [];
    const pushApi = apiWithPushCapture(api, pushes);
    for (const path of ['/posts/public-local/fresh', '/posts/public-local/reload']) {
      assert.equal((await post(app, path, null, pushApi)).status, 200);
      assert.ok(
        pushes.some(({ body }) => body.includes('PUBLIC BODY')),
        `${path}: ${JSON.stringify(pushes)}`,
      );
    }

    const fresh = await post(app, '/posts/unlisted-remote/fresh', null, pushApi);
    assert.equal(fresh.status, 200);
    assert.equal(queue.length, 1, 'unlisted remote posts still get a Like');
    assert.equal(queue[0].inboxUrl, `${REMOTE_BOB}/inbox`);
    assert.equal(queue[0].activity?.type, 'Like');
    assert.equal(queue[0].activity?.object, `${REMOTE}/notes/unlisted-remote`);

    queue.length = 0;
    const reload = await post(app, '/posts/unlisted-remote/reload', null, pushApi);
    assert.equal(reload.status, 200);
    assert.equal(queue.length, 1, 'unlisted remote posts still get an Announce');
    assert.equal(queue[0].inboxUrl, `${REMOTE_BOB}/inbox`);
    assert.equal(queue[0].activity?.type, 'Announce');
    assert.equal(queue[0].activity?.object, `${REMOTE}/notes/unlisted-remote`);

    // Toggle off again so the batch add actually re-likes the remote post.
    await post(app, '/posts/unlisted-remote/fresh', null, pushApi);
    queue.length = 0;
    const batch = await post(app, '/posts/fresh/batch', { post_ids: ['unlisted-remote'], action: 'add' }, pushApi);
    assert.equal(batch.status, 200);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].activity?.type, 'Like');
    assert.equal(queue[0].activity?.object, `${REMOTE}/notes/unlisted-remote`);
  });
});
