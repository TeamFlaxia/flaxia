import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs the same resolver shim used by the other visibility test suites.
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

const { social } = await import('../functions/api/routes/users/social.ts');
const { feed } = await import('../functions/api/routes/posts/feed.ts');
const { filterVisiblePosts } = await import('../functions/api/routes/posts/helpers.ts');

// The shared test adapter's `all()` has no `success` flag; the production
// helpers check it exactly like real D1. Mirror it locally.
type TestStatement = ReturnType<TestDatabase['prepare']>;

function wrapStatement(statement: TestStatement): TestStatement {
  return {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
    first: <T>() => statement.first<T>(),
    all: async <T>() =>
      ({ ...(await statement.all<T>()), success: true }) as Awaited<ReturnType<TestStatement['all']>> & {
        success: boolean;
      },
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

type AppEnv = { Bindings: Bindings; Variables: Variables };

const NOW = '2026-11-26T00:00:00.000Z';
const REMOTE_ACTOR = 'https://remote.example/users/remuser';

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
const REMOTE_OWNER: User = {
  id: 'remote-owner',
  email: 'remote-owner@test.com',
  username: 'remuser',
  display_name: 'Remote User',
  bio: '',
  created_at: NOW,
};

const databases: TestDatabase[] = [];
let db: TestDatabase;

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  for (const user of [ALICE, BOB, REMOTE_OWNER]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, NOW)
      .run();
  }
  db.prepare(
    `INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, display_name, domain, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, 'remuser', 'Remote User', 'remote.example', NOW)
    .run();
});

after(() => {
  for (const database of databases) database.close();
});

function envFor(): Bindings {
  return { DB: wrapDb(db) as unknown as Bindings['DB'] } as Bindings;
}

function appFor(route: Hono<AppEnv>, viewer: User | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', viewer);
    await next();
  });
  app.route('/', route);
  return app;
}

function seedRemotePrivatePost(): void {
  db.prepare(
    `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, parent_id, root_id,
       status, created_at, visibility, actor_id, ap_object_id)
     VALUES ('remote-private', ?, 'remuser', 'REMOTE PRIVATE SECRET', '[]', '[]', NULL, NULL,
       'published', ?, 'private', ?, ?)`,
  )
    .bind(REMOTE_OWNER.id, NOW, REMOTE_ACTOR, `${REMOTE_ACTOR}/statuses/1`)
    .run();
}

function seedRemoteFollow(status: string): void {
  db.prepare(
    `INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, status)
     VALUES ('follow-1', ?, ?, ?, ?)`,
  )
    .bind(ALICE.id, REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, status)
    .run();
}

async function visibleRemoteIds(viewer: string | null): Promise<string[]> {
  const rows = await db
    .prepare('SELECT * FROM posts WHERE id = ?')
    .bind('remote-private')
    .all<Record<string, unknown>>();
  const visible = await filterVisiblePosts(wrapDb(db) as unknown as D1Database, viewer, rows.results);
  return visible.map((post) => String(post.id));
}

async function remoteProfileIds(viewer: User | null): Promise<{ status: number; ids: string[]; text: string }> {
  const response = await appFor(social, viewer).request(
    'http://localhost/remote/actors/remote.example/remuser',
    {},
    envFor(),
  );
  const text = await response.text();
  let ids: string[] = [];
  try {
    const body = JSON.parse(text) as { posts?: Array<{ id: string }> };
    ids = (body.posts ?? []).map((post) => post.id);
  } catch {
    // A non-JSON response is a failure of this test, asserted via status/ids.
  }
  return { status: response.status, ids, text };
}

describe('pending remote follows', () => {
  it('never grants access to a followers-only remote note while the follow is unsent/pending/rejected', async () => {
    seedRemotePrivatePost();
    assert.deepEqual(await visibleRemoteIds(ALICE.id), [], 'no follow at all must not grant access');

    for (const status of ['sent', 'pending', 'rejected']) {
      db.prepare('DELETE FROM ap_following').run();
      seedRemoteFollow(status);
      assert.deepEqual(await visibleRemoteIds(ALICE.id), [], `ap_following status ${status} must not grant access`);
    }

    db.prepare("UPDATE ap_following SET status = 'accepted' WHERE local_user_id = ?").bind(ALICE.id).run();
    assert.deepEqual(await visibleRemoteIds(ALICE.id), ['remote-private'], 'an accepted follow must grant access');
    assert.deepEqual(await visibleRemoteIds(BOB.id), [], 'another local user must still be denied');
  });

  it('does not expose the private note on the remote profile during a pending follow', async () => {
    seedRemotePrivatePost();
    seedRemoteFollow('sent');

    for (const viewer of [null, BOB]) {
      const response = await remoteProfileIds(viewer);
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(response.ids, [], `${viewer?.username ?? 'anonymous'} must not see the private note`);
      assert.equal(response.text.includes('REMOTE PRIVATE SECRET'), false);
    }
    const pending = await remoteProfileIds(ALICE);
    assert.equal(pending.status, 200, pending.text);
    assert.deepEqual(pending.ids, [], 'a sent follow request is not an accepted follow');
    assert.equal(pending.text.includes('REMOTE PRIVATE SECRET'), false);

    db.prepare("UPDATE ap_following SET status = 'accepted' WHERE local_user_id = ?").bind(ALICE.id).run();
    const accepted = await remoteProfileIds(ALICE);
    assert.deepEqual(accepted.ids, ['remote-private'], 'the post becomes visible once the follow is accepted');
    assert.equal(accepted.text.includes('REMOTE PRIVATE SECRET'), true);
  });
});

/** A user-agnostic trending payload that still contains moderated posts. */
class FakeCache {
  private posts: Array<Record<string, unknown>> = [];

  setPosts(posts: Array<Record<string, unknown>>): void {
    this.posts = posts;
  }

  async get(key: string): Promise<string | null> {
    return key.startsWith('trending:') ? JSON.stringify({ posts: this.posts }) : null;
  }

  async put(): Promise<void> {
    // The cache is pre-seeded; no writes are needed for these tests.
  }
}

function seedLocalPost(id: string, options: { hidden?: number; status?: string } = {}): void {
  db.prepare(
    `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, parent_id, root_id,
       status, hidden, created_at, visibility)
     VALUES (?, ?, 'alice', ?, '[]', '[]', NULL, NULL, ?, ?, ?, 'public')`,
  )
    .bind(id, ALICE.id, `POST ${id}`, options.status ?? 'published', options.hidden ?? 0, NOW)
    .run();
}

describe('trending KV cache hit rechecks publication state', () => {
  it('drops hidden and unpublished posts that are still present in the cached payload', async () => {
    db.prepare('DELETE FROM posts').run(); // migrations ship demo posts
    seedLocalPost('post-public');
    seedLocalPost('post-hidden', { hidden: 1 });
    seedLocalPost('post-pending', { status: 'pending' });
    const stored = await db.prepare('SELECT * FROM posts ORDER BY id').all<Record<string, unknown>>();
    const cache = new FakeCache();
    cache.setPosts(stored.results);

    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('user', null);
      await next();
    });
    app.route('/', feed);

    const response = await app.request(
      'http://localhost/posts/trending?limit=20',
      {},
      {
        ...envFor(),
        CACHE: cache as unknown as Bindings['CACHE'],
      },
    );
    const text = await response.clone().text();
    assert.equal(response.status, 200, text);
    const body = (await response.json()) as { posts: Array<{ id: string; text: string }> };
    assert.deepEqual(
      body.posts.map((post) => post.id),
      ['post-public'],
      'only a published, non-hidden post may survive a cache hit',
    );
    assert.equal(text.includes('POST post-hidden'), false);
    assert.equal(text.includes('POST post-pending'), false);
  });
});
