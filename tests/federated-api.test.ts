// Behavioural tests for the public federated popularity feed.
//
// The real Hono router runs against the real migrations through the shared
// D1 adapter, so an invalid join, cursor or block predicate fails here the
// same way it would in production.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs the same resolver shim used by the other API tests.
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

const { default: federatedRouter } = await import('../functions/api/routes/federated.ts');

type AppEnv = { Bindings: Bindings; Variables: Variables };
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

const ACTOR_A = 'https://mastodon.example/users/alice';
const ACTOR_B = 'https://other.example/users/bob';
const ACTOR_C = 'https://third.example/users/cara';

const databases: TestDatabase[] = [];
let db: TestDatabase;

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  // Migration 0150 is owned by another worker; keep the fixture usable even
  // if that file is not present yet. No-op when the real migration exists.
  db.exec(
    `CREATE TABLE IF NOT EXISTS ap_pool_metrics (
       post_id TEXT PRIMARY KEY, instance TEXT NOT NULL, favourites INTEGER NOT NULL DEFAULT 0,
       reblogs INTEGER NOT NULL DEFAULT 0, score REAL NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL
     )`,
  );
  // 0002 seeds demo posts; start from an empty timeline.
  db.prepare('DELETE FROM posts').run();
  db.prepare('DELETE FROM ap_pool_metrics').run();
  for (const user of [ALICE, BOB]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, NOW)
      .run();
  }
  for (const [actorUrl, domain, name] of [
    [ACTOR_A, 'mastodon.example', 'alice'],
    [ACTOR_B, 'other.example', 'bob'],
    [ACTOR_C, 'third.example', 'cara'],
  ]) {
    db.prepare(
      `INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, display_name, icon_url, domain, fetched_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
      .bind(actorUrl, `${actorUrl}/inbox`, name, name.toUpperCase(), domain, NOW)
      .run();
  }
});

after(() => {
  for (const database of databases) database.close();
});

type SeedPost = {
  id: string;
  actor: string | null;
  userId?: string;
  score: number;
  createdAt?: string;
  hidden?: number;
  status?: string;
  favourites?: number;
  reblogs?: number;
};

function seedPoolPost(post: SeedPost): void {
  const createdAt = post.createdAt ?? NOW;
  db.prepare(
    `INSERT INTO posts (id, user_id, username, text, hashtags, actor_id, ap_object_id,
                        status, hidden, visibility, created_at)
     VALUES (?, ?, 'remote', ?, '[]', ?, ?, ?, ?, 'public', ?)`,
  )
    .bind(
      post.id,
      post.userId ?? '',
      `note ${post.id}`,
      post.actor,
      `https://example.example/notes/${post.id}`,
      post.status ?? 'published',
      post.hidden ?? 0,
      createdAt,
    )
    .run();
  db.prepare(
    `INSERT INTO ap_pool_metrics (post_id, instance, favourites, reblogs, score, fetched_at)
     VALUES (?, 'mastodon.example', ?, ?, ?, ?)`,
  )
    .bind(post.id, post.favourites ?? 0, post.reblogs ?? 0, post.score, createdAt)
    .run();
}

function appFor(viewer: User | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', viewer);
    await next();
  });
  app.route('/', federatedRouter);
  return app;
}

type FeedResponse = {
  posts: Array<Record<string, unknown> & { id: string; pool_score: number }>;
  next_cursor: string | null;
};

async function getFeed(app: Hono<AppEnv>, path: string): Promise<FeedResponse> {
  const response = await app.request(`http://localhost${path}`, {}, {
    DB: wrapDb(db) as unknown as Bindings['DB'],
  } as Bindings);
  assert.equal(response.status, 200, `${path} → ${response.status}: ${await response.clone().text()}`);
  return (await response.json()) as FeedResponse;
}

function ids(posts: Array<{ id: string }>): string[] {
  return posts.map((post) => post.id);
}

describe('GET /api/federated/posts', () => {
  it('is public and orders the pool by score rather than by time', async () => {
    // A newer post has a lower score: chronological order would be p-low first.
    seedPoolPost({ id: 'p-low', actor: ACTOR_A, score: 1, createdAt: '2026-11-26T12:00:00.000Z' });
    seedPoolPost({ id: 'p-high', actor: ACTOR_B, score: 9, createdAt: '2026-11-25T01:00:00.000Z' });
    seedPoolPost({ id: 'p-mid', actor: ACTOR_C, score: 5, createdAt: '2026-11-24T01:00:00.000Z' });

    const data = await getFeed(appFor(null), '/federated/posts');
    assert.deepEqual(ids(data.posts), ['p-high', 'p-mid', 'p-low']);
    assert.deepEqual(
      data.posts.map((post) => post.pool_score),
      [9, 5, 1],
    );
  });

  it('excludes hidden, unpublished and non-federated rows', async () => {
    seedPoolPost({ id: 'p-ok', actor: ACTOR_A, score: 3 });
    seedPoolPost({ id: 'p-hidden', actor: ACTOR_A, score: 8, hidden: 1 });
    seedPoolPost({ id: 'p-draft', actor: ACTOR_A, score: 7, status: 'draft' });
    // A local post has no pool metrics, but a local row with metrics still
    // must not leak into the federated tab.
    db.prepare(
      `INSERT INTO posts (id, user_id, username, text, status, hidden, visibility, created_at)
       VALUES ('p-local', 'bob', 'bob', 'local only', 'published', 0, 'public', ?)`,
    )
      .bind(NOW)
      .run();
    db.prepare(
      `INSERT INTO ap_pool_metrics (post_id, instance, favourites, reblogs, score, fetched_at)
       VALUES ('p-local', 'mastodon.example', 0, 0, 99, ?)`,
    )
      .bind(NOW)
      .run();

    const data = await getFeed(appFor(null), '/federated/posts');
    assert.deepEqual(ids(data.posts), ['p-ok']);
  });

  it('applies the viewer ap_blocks and local blocks', async () => {
    seedPoolPost({ id: 'p-keep', actor: ACTOR_A, score: 6 });
    seedPoolPost({ id: 'p-remote-blocked', actor: ACTOR_B, score: 8 });
    seedPoolPost({ id: 'p-local-blocked', actor: ACTOR_C, score: 7, userId: BOB.id });
    db.prepare('INSERT INTO ap_blocks (id, local_user_id, actor_url) VALUES (?, ?, ?)')
      .bind('block-1', ALICE.id, ACTOR_B)
      .run();
    db.prepare('INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').bind(ALICE.id, BOB.id).run();

    const guest = await getFeed(appFor(null), '/federated/posts');
    assert.deepEqual(ids(guest.posts), ['p-remote-blocked', 'p-local-blocked', 'p-keep']);

    const blocked = await getFeed(appFor(ALICE), '/federated/posts');
    assert.deepEqual(ids(blocked.posts), ['p-keep']);
  });

  it('paginates by (score, created_at, id) with ties', async () => {
    seedPoolPost({ id: 'p-a', actor: ACTOR_A, score: 5, createdAt: '2026-11-20T00:00:00.000Z' });
    seedPoolPost({ id: 'p-b', actor: ACTOR_A, score: 5, createdAt: '2026-11-20T00:00:00.000Z' });
    seedPoolPost({ id: 'p-newer', actor: ACTOR_A, score: 5, createdAt: '2026-11-21T00:00:00.000Z' });
    seedPoolPost({ id: 'p-tail', actor: ACTOR_A, score: 2, createdAt: '2026-11-19T00:00:00.000Z' });

    const app = appFor(null);
    const first = await getFeed(app, '/federated/posts?limit=2');
    assert.deepEqual(ids(first.posts), ['p-newer', 'p-b']);
    assert.ok(first.next_cursor, 'a full page must expose a cursor');

    const second = await getFeed(app, `/federated/posts?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`);
    assert.deepEqual(ids(second.posts), ['p-a', 'p-tail']);
    const third = await getFeed(app, `/federated/posts?limit=2&cursor=${encodeURIComponent(second.next_cursor!)}`);
    assert.deepEqual(ids(third.posts), []);
    assert.equal(third.next_cursor, null);
  });

  it('rejects an unusable cursor and clamps the page size', async () => {
    seedPoolPost({ id: 'p-a', actor: ACTOR_A, score: 4 });
    const app = appFor(null);
    const data = await getFeed(app, '/federated/posts?limit=999&cursor=not-a-cursor');
    assert.deepEqual(ids(data.posts), ['p-a']);
  });

  it('enriches remote authors before responding', async () => {
    seedPoolPost({ id: 'p-ok', actor: ACTOR_B, score: 4, favourites: 12, reblogs: 3 });
    const data = await getFeed(appFor(ALICE), '/federated/posts');
    const post = data.posts[0];
    assert.equal(post.actor_id, ACTOR_B);
    assert.equal(post.username, 'bob@other.example');
    assert.equal(post.display_name, 'BOB');
    assert.equal(post.is_remote, true);
    assert.equal(post.profile_path, '/@other.example/bob');
    assert.equal(post.avatar_key, null);
    assert.equal(post.pool_score, 4);
    assert.ok('is_freshed' in post, 'enrichFeedPosts must add per-viewer flags');
  });
});
