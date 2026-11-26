import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import type { PushPayload } from '../functions/lib/push.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// The shared adapter's `all()` has no `success` flag, while real handlers
// inspect it exactly like D1. Add it locally (same pattern as post-visibility).
type TestStatement = ReturnType<TestDatabase['prepare']>;
type AllResult<T> = { results: T[]; success: boolean };

function wrapStatement(statement: TestStatement): TestStatement {
  return {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
    first: <T>() => statement.first<T>(),
    all: async <T>() => ({ ...(await statement.all<T>()), success: true }) as AllResult<T> as { results: T[] },
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

// Route modules use extensionless imports for the Worker bundler; Node needs
// the same resolver shim the other behavioural API suites use.
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

const { composer } = await import('../functions/api/routes/posts/composer.ts');

type AppEnv = { Bindings: Bindings; Variables: Variables };
type CapturedPush = { userId: string; payload: PushPayload };

const NOW = '2026-11-26T00:00:00.000Z';
const ALICE: User = {
  id: 'alice',
  email: 'alice@test.com',
  username: 'alice',
  display_name: 'Alice',
  bio: '',
  created_at: NOW,
};
const BOB: User = {
  id: 'bob',
  email: 'bob@test.com',
  username: 'bob',
  display_name: 'Bob',
  bio: '',
  created_at: NOW,
};
const CAROL: User = {
  id: 'carol',
  email: 'carol@test.com',
  username: 'carol',
  display_name: 'Carol',
  bio: '',
  created_at: NOW,
};

const QUOTED_POST_ID = 'quoted-target';

const databases: TestDatabase[] = [];
let db: TestDatabase;
let pushes: CapturedPush[];
let postCounter = 0;

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  db.prepare('DELETE FROM posts').run();
  for (const user of [ALICE, BOB, CAROL]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, NOW)
      .run();
  }
  // Alice owns the post everyone quotes below; Bob is the poster under test.
  db.prepare(
    `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, status, visibility, created_at)
     VALUES (?, ?, ?, ?, '[]', '[]', 'published', 'public', ?)`,
  )
    .bind(QUOTED_POST_ID, ALICE.id, ALICE.username, 'original post by alice', NOW)
    .run();
  pushes = [];
});

after(() => {
  for (const database of databases) database.close();
});

function envFor(database: TestDatabase): Bindings {
  // sendPushToAll delivers through the notification DO when present; the fake
  // stub records the exact payload a recipient would receive.
  const notificationStream = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (_url: string, init?: RequestInit) => {
        const message = JSON.parse(String(init?.body)) as { push?: PushPayload };
        if (message.push) pushes.push({ userId: id, payload: message.push });
        return new Response(null, { status: 204 });
      },
    }),
  };
  return {
    DB: wrapDb(database) as unknown as Bindings['DB'],
    BASE_URL: 'http://localhost',
    NOTIFICATION_STREAM: notificationStream,
  } as unknown as Bindings;
}

function appFor(viewer: User): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', viewer);
    await next();
  });
  app.route('/', composer);
  return app;
}

/** Let the `waitUntil`-scheduled push tasks settle after the response. */
async function flushBackground(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function commitQuote(options: {
  text: string;
  visibility: 'public' | 'private' | 'direct';
  quotedPostId?: string;
  viewer?: User;
}): Promise<{ status: number; postId: string; body: string }> {
  const postId = `quote-${++postCounter}`;
  const response = await appFor(options.viewer ?? BOB).request(
    'http://localhost/posts/commit',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postId,
        text: options.text,
        visibility: options.visibility,
        quotedPostId: options.quotedPostId ?? QUOTED_POST_ID,
      }),
    },
    envFor(db),
  );
  const body = await response.text();
  await flushBackground();
  return { status: response.status, postId, body };
}

async function quoteNotifications(userId: string): Promise<Array<{ id: string; post_id: string }>> {
  const rows = await db
    .prepare("SELECT id, post_id FROM notifications WHERE user_id = ? AND type = 'quote'")
    .bind(userId)
    .all<{ id: string; post_id: string }>();
  return rows.results;
}

async function notificationsOfType(userId: string, type: string): Promise<Array<{ id: string; post_id: string }>> {
  const rows = await db
    .prepare('SELECT id, post_id FROM notifications WHERE user_id = ? AND type = ?')
    .bind(userId, type)
    .all<{ id: string; post_id: string }>();
  return rows.results;
}

async function storedVisibility(postId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT visibility FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ visibility: string }>();
  return row?.visibility ?? null;
}

function pushesTo(userId: string): PushPayload[] {
  return pushes.filter((push) => push.userId === userId).map((push) => push.payload);
}

describe('mention notifications must obey the new post visibility', () => {
  async function commitMention(text: string, visibility: 'public' | 'private' | 'direct'): Promise<string> {
    const postId = `mention-${++postCounter}`;
    const response = await appFor(BOB).request(
      'http://localhost/posts/commit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postId, text, visibility }),
      },
      envFor(db),
    );
    assert.equal(response.status, 200, await response.clone().text());
    await flushBackground();
    return postId;
  }

  it('does not notify a mentioned user who cannot read a followers-only post', async () => {
    await commitMention('@carol FOLLOWERS_ONLY_MENTION_SECRET', 'private');
    assert.deepEqual(await notificationsOfType(CAROL.id, 'mention'), []);
    assert.deepEqual(pushesTo(CAROL.id), []);
  });

  it('sends restricted mentions as metadata only, even to an authorized reader', async () => {
    db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(CAROL.id, BOB.id).run();
    const postId = await commitMention('@carol FOLLOWER_MENTION_SECRET', 'private');
    const notifications = await notificationsOfType(CAROL.id, 'mention');
    assert.deepEqual(
      notifications.map((notification) => notification.post_id),
      [postId],
    );
    const payloads = pushesTo(CAROL.id);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].body?.includes('FOLLOWER_MENTION_SECRET'), false, 'push must not carry the private text');
  });

  it('sends a direct mention to its recipient without the private body in the push', async () => {
    const postId = await commitMention('@carol DIRECT_MENTION_SECRET', 'direct');
    assert.deepEqual(
      (await notificationsOfType(CAROL.id, 'mention')).map((n) => n.post_id),
      [postId],
    );
    const payloads = pushesTo(CAROL.id);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].body?.includes('DIRECT_MENTION_SECRET'), false);
  });
});

describe('quote notifications must obey the new post visibility', () => {
  it('preserves the public behaviour: quoted author gets a quote notification and a push with the text', async () => {
    const text = 'PUBLIC_QUOTE_BODY_123';
    const { status, postId, body } = await commitQuote({ text, visibility: 'public' });
    assert.equal(status, 200, body);
    assert.equal(await storedVisibility(postId), 'public');

    const notifications = (await quoteNotifications(ALICE.id)).filter((n) => n.post_id === postId);
    assert.equal(notifications.length, 1, 'public quote should notify the quoted author');
    assert.ok(
      pushesTo(ALICE.id).some((payload) => payload.body?.includes(text)),
      'public quote push should still carry the post text',
    );
  });

  it('private quote of a non-follower leaks neither notification nor push', async () => {
    const text = 'PRIVATE_QUOTE_SECRET_456';
    const { status, postId, body } = await commitQuote({ text, visibility: 'private' });
    assert.equal(status, 200, body);
    assert.equal(await storedVisibility(postId), 'private');

    // Alice does not follow Bob, so /api/posts/:id would refuse her this post.
    assert.deepEqual(
      (await quoteNotifications(ALICE.id)).filter((n) => n.post_id === postId),
      [],
      'a reader who cannot see a private post must not be notified about it',
    );
    assert.deepEqual(pushesTo(ALICE.id), [], 'no push must be sent to a non-recipient');
  });

  it('direct quote of a non-mentioned quoted author leaks neither notification nor push', async () => {
    const text = '@carol DIRECT_QUOTE_SECRET_789';
    const { status, postId, body } = await commitQuote({ text, visibility: 'direct' });
    assert.equal(status, 200, body);
    assert.equal(await storedVisibility(postId), 'direct');

    // The fixture resolved Carol's mention, proving direct addressing works.
    assert.equal((await notificationsOfType(CAROL.id, 'mention')).filter((n) => n.post_id === postId).length, 1);

    assert.deepEqual(
      (await quoteNotifications(ALICE.id)).filter((n) => n.post_id === postId),
      [],
      'a non-mentioned reader of a direct post must not get a quote notification',
    );
    assert.deepEqual(pushesTo(ALICE.id), [], 'no push must be sent to a non-mentioned reader');
  });

  it('private quote of a follower may notify, but the push carries no private text', async () => {
    // Alice follows Bob, so she is an allowed reader of Bob's private post.
    db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(ALICE.id, BOB.id).run();
    const text = 'FOLLOWERS_ONLY_SECRET_321';
    const { status, body } = await commitQuote({ text, visibility: 'private' });
    assert.equal(status, 200, body);

    // A notification is permitted (metadata only), but the private body must
    // never travel through the push payload.
    for (const payload of pushesTo(ALICE.id)) {
      assert.ok(!payload.body?.includes(text), `push leaked the private post body: ${payload.body}`);
    }
  });

  it('direct quote naming the quoted author may notify, but the push carries no private text', async () => {
    const text = `@alice DIRECT_SECRET_FOR_ALICE_654`;
    const { status, postId, body } = await commitQuote({ text, visibility: 'direct' });
    assert.equal(status, 200, body);
    assert.equal(await storedVisibility(postId), 'direct');

    for (const payload of pushesTo(ALICE.id)) {
      assert.ok(!payload.body?.includes(text), `push leaked the direct post body: ${payload.body}`);
    }
  });
});
