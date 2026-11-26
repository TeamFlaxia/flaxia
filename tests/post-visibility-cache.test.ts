import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

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

const { feed } = await import('../functions/api/routes/posts/feed.ts');
const { search } = await import('../functions/api/routes/posts/search.ts');
const { filterVisiblePosts } = await import('../functions/api/routes/posts/helpers.ts');

// The shared test adapter's `all()` has no `success` flag, while the route
// handlers check it exactly like real D1. Add the flag locally so the real
// handlers can run against the in-memory database.
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
const SEARCH_QUERY = 'visibilitytoken';
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

const databases: TestDatabase[] = [];
let db: TestDatabase;
let cache: FakeCache;

/**
 * A user-agnostic KV payload: it deliberately contains every post, including
 * restricted ones, so only the cache-hit visibility re-check can remove them.
 */
class FakeCache {
  readonly getCalls: string[] = [];
  private posts: Array<Record<string, unknown>> = [];

  setPosts(posts: Array<Record<string, unknown>>): void {
    this.posts = posts;
  }

  postsForTest(): Array<Record<string, unknown>> {
    return [...this.posts];
  }

  async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    if (key.startsWith('trending:')) return JSON.stringify({ posts: this.posts });
    if (key.startsWith('search:')) {
      return JSON.stringify({ type: 'posts', query: SEARCH_QUERY, results: this.posts, users: [] });
    }
    return null;
  }

  async put(): Promise<void> {
    // No writes are needed to force a deterministic cache hit.
  }
}

beforeEach(async () => {
  db = createTestDatabase();
  databases.push(db);
  cache = new FakeCache();
  db.prepare('DELETE FROM posts').run();
  for (const user of [ALICE, BOB, CAROL]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, NOW)
      .run();
  }
  // Carol follows Alice; Bob does not follow anybody.
  db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(CAROL.id, ALICE.id).run();

  seedPost({ id: 'public-1', text: `${SEARCH_QUERY} public` });
  seedPost({ id: 'unlisted-1', text: `${SEARCH_QUERY} unlisted`, visibility: 'unlisted' });
  seedPost({ id: 'private-alice', text: `${SEARCH_QUERY} private`, visibility: 'private' });
  seedPost({
    id: 'direct-alice',
    text: `${SEARCH_QUERY} direct`,
    visibility: 'direct',
    mentions: [{ username: 'bob', user_id: BOB.id }],
  });
  seedPost({ id: 'private-bob', author: BOB, text: `${SEARCH_QUERY} bob private`, visibility: 'private' });

  const stored = await db.prepare('SELECT * FROM posts ORDER BY id').all<Record<string, unknown>>();
  cache.setPosts(stored.results);
});

after(() => {
  for (const database of databases) database.close();
});

function seedPost(post: {
  id: string;
  author?: User;
  text: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  mentions?: unknown[];
}): void {
  const author = post.author ?? ALICE;
  db.prepare(
    `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, parent_id, root_id, status, created_at, visibility)
     VALUES (?, ?, ?, ?, '[]', ?, NULL, NULL, 'published', ?, ?)`,
  )
    .bind(
      post.id,
      author.id,
      author.username,
      post.text,
      JSON.stringify(post.mentions ?? []),
      NOW,
      post.visibility ?? 'public',
    )
    .run();
}

function envFor(): Bindings {
  return {
    DB: wrapDb(db) as unknown as Bindings['DB'],
    CACHE: cache as unknown as Bindings['CACHE'],
  } as Bindings;
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

async function getIds(app: Hono<AppEnv>, path: string, key: 'posts' | 'results'): Promise<string[]> {
  const response = await app.request(`http://localhost${path}`, {}, envFor());
  assert.equal(response.status, 200, `${path} → ${response.status}: ${await response.clone().text()}`);
  const data = (await response.json()) as Record<string, Array<{ id: string }>>;
  return data[key].map((post) => post.id).sort();
}

// Exact id sets a viewer may see out of the five leaky cached posts.
const VISIBLE_TO: Record<string, string[]> = {
  anonymous: ['public-1', 'unlisted-1'],
  bob: ['direct-alice', 'private-bob', 'public-1', 'unlisted-1'],
  carol: ['private-alice', 'public-1', 'unlisted-1'],
  alice: ['direct-alice', 'private-alice', 'public-1', 'unlisted-1'],
};

describe('filterVisiblePosts() on real SQLite', () => {
  it('lets an anonymous viewer keep only public and unlisted ids', async () => {
    const posts = cache.postsForTest();
    assert.deepEqual(
      (await filterVisiblePosts(wrapDb(db) as unknown as D1Database, null, posts)).map((p) => String(p.id)).sort(),
      VISIBLE_TO.anonymous,
    );
  });

  it('lets the author, follower and mentioned viewer see their own ids but not strangers', async () => {
    const posts = cache.postsForTest();
    for (const [viewer, user] of [
      ['bob', BOB],
      ['carol', CAROL],
      ['alice', ALICE],
    ] as const) {
      assert.deepEqual(
        (await filterVisiblePosts(wrapDb(db) as unknown as D1Database, user.id, posts)).map((p) => String(p.id)).sort(),
        VISIBLE_TO[viewer],
        viewer,
      );
    }
  });
});

describe('trending KV cache hit', () => {
  it('returns exactly the ids visible to each viewer', async () => {
    for (const [viewer, user] of [
      ['anonymous', null],
      ['bob', BOB],
      ['carol', CAROL],
      ['alice', ALICE],
    ] as const) {
      const app = appFor(feed, user);
      assert.deepEqual(await getIds(app, '/posts/trending?limit=20', 'posts'), VISIBLE_TO[viewer], viewer);
    }
    assert.ok(
      cache.getCalls.some((key) => key.startsWith('trending:')),
      'the trending cache was read',
    );
  });
});

describe('search KV cache hit', () => {
  it('returns exactly the ids visible to each viewer', async () => {
    for (const [viewer, user] of [
      ['anonymous', null],
      ['bob', BOB],
      ['carol', CAROL],
      ['alice', ALICE],
    ] as const) {
      const app = appFor(search, user);
      assert.deepEqual(await getIds(app, `/search?q=${SEARCH_QUERY}&limit=20`, 'results'), VISIBLE_TO[viewer], viewer);
    }
    assert.ok(
      cache.getCalls.some((key) => key.startsWith('search:')),
      'the search cache was read',
    );
  });
});

describe('remote notes obey their stored audience', () => {
  async function seedRemote(id: string, visibility: string, mentions: string): Promise<void> {
    const actor = `https://remote.example/users/${id}`;
    db.prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, parent_id, root_id, status, created_at,
        visibility, actor_id, ap_object_id)
       VALUES (?, '', 'remoteuser', ?, '[]', ?, NULL, NULL, 'published', ?, ?, ?, ?)`,
    )
      .bind(id, `remote ${id}`, mentions, NOW, visibility, actor, `${actor}/statuses/1`)
      .run();
  }

  async function visibleIds(viewer: string | null, id: string): Promise<string[]> {
    const rows = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).all<Record<string, unknown>>();
    const posts = await filterVisiblePosts(wrapDb(db) as unknown as D1Database, viewer, rows.results);
    return posts.map((post) => String(post.id)).sort();
  }

  it('hides a remote direct note from everyone except its mentioned local user', async () => {
    await seedRemote('remote-direct', 'direct', JSON.stringify([{ username: 'bob', user_id: BOB.id }]));
    assert.deepEqual(await visibleIds(null, 'remote-direct'), []);
    assert.deepEqual(await visibleIds(CAROL.id, 'remote-direct'), []);
    assert.deepEqual(await visibleIds(BOB.id, 'remote-direct'), ['remote-direct']);
  });

  it('fails closed instead of throwing when a remote note has malformed mentions JSON', async () => {
    await seedRemote('remote-broken', 'direct', 'not json');
    assert.deepEqual(await visibleIds(BOB.id, 'remote-broken'), []);
  });
});
