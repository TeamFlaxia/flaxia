import assert from 'node:assert';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';
import { BASE_URL, loginUser, registerUser, resetDb, seedUserAndLogin } from './helpers/setup.ts';

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs the same resolver shim used by the other D1-backed API tests.
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

const { default: searchRouter } = await import('../functions/api/routes/search.ts');

interface SearchResponse {
  posts: Array<{
    id: string;
    text: string;
    username: string;
    reactions?: Array<{ emoji: string; count: number; reacted: boolean }>;
    quoted_post?: { id: string } | null;
  }>;
  users: Array<{ id: string; username: string; display_name: string }>;
  games: Array<{ id: string }>;
  web: Array<{ title: string; url: string }>;
}

async function search(query: string, tab = 'all', cookie?: string): Promise<SearchResponse> {
  const response = await fetch(`${BASE_URL}/api/search/v2?q=${encodeURIComponent(query)}&tab=${tab}&limit=20`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  assert.equal(response.status, 200);
  return (await response.json()) as SearchResponse;
}

describe('GET /api/search/v2', () => {
  beforeEach(resetDb);

  it('finds posts by full text and falls back for short CJK queries', async () => {
    const { cookie, username } = await seedUserAndLogin('search-text');
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const create = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: first, text: '猫が好きです #検索テスト', hashtags: ['検索テスト'] }),
    });
    assert.equal(create.status, 200);
    await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: second, text: '犬と散歩しました', hashtags: [] }),
    });

    const long = await search('好きです', 'posts', cookie);
    assert.deepEqual(
      long.posts.map((post) => post.id),
      [first],
    );

    const short = await search('猫', 'posts', cookie);
    assert.deepEqual(
      short.posts.map((post) => post.id),
      [first],
    );

    const users = await search(username, 'users', cookie);
    assert.ok(users.users.some((user) => user.username === username));
  });

  it('honors hashtag and author filters', async () => {
    const { cookie, username } = await seedUserAndLogin('search-filter');
    const tagged = crypto.randomUUID();
    await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: tagged, text: 'filtered result #needle', hashtags: ['needle'] }),
    });

    const byTag = await search('#needle', 'posts', cookie);
    assert.ok(byTag.posts.some((post) => post.id === tagged));

    const byAuthor = await search(`from:${username} filtered`, 'posts', cookie);
    assert.ok(byAuthor.posts.some((post) => post.id === tagged));

    const otherAuthor = await search('from:someone-else filtered', 'posts', cookie);
    assert.ok(!otherAuthor.posts.some((post) => post.id === tagged));
  });

  it('finds short usernames through the LIKE fallback', async () => {
    await registerUser({
      email: 'short@test.com',
      password: 'password123',
      username: 'ab',
      display_name: 'Short Name',
    });
    await loginUser('short@test.com', 'password123');

    const result = await search('ab', 'users');
    assert.ok(result.users.some((user) => user.username === 'ab'));
  });

  it('enriches results with reactions and quoted posts', async () => {
    const { cookie } = await seedUserAndLogin('search-enrich');
    const target = crypto.randomUUID();
    const targetCreate = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: target, text: 'enrich-target-post', hashtags: [] }),
    });
    assert.equal(targetCreate.status, 200);

    const quote = crypto.randomUUID();
    const quoteCreate = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: quote, text: 'enrich-quote-post', hashtags: [], quotedPostId: target }),
    });
    assert.equal(quoteCreate.status, 200);

    const react = await fetch(`${BASE_URL}/api/posts/${target}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ emoji: '🔥' }),
    });
    assert.equal(react.status, 200);

    const targetResults = await search('enrich-target-post', 'posts', cookie);
    const targetPost = targetResults.posts.find((post) => post.id === target);
    assert.ok(targetPost?.reactions?.some((reaction) => reaction.emoji === '🔥' && reaction.reacted));

    const quoteResults = await search('enrich-quote-post', 'posts', cookie);
    const quotePost = quoteResults.posts.find((post) => post.id === quote);
    assert.equal(quotePost?.quoted_post?.id, target);
  });

  it('rejects an empty query', async () => {
    const response = await fetch(`${BASE_URL}/api/search/v2?q=&tab=all`);
    assert.equal(response.status, 400);
  });
});

describe('GET /api/search/v2 visibility (real D1)', () => {
  type AppEnv = { Bindings: Bindings; Variables: Variables };
  type TestStatement = ReturnType<TestDatabase['prepare']>;

  const NOW = '2026-11-26T00:00:00.000Z';
  const AFTER = '2026-11-27T00:00:00.000Z';
  const LATER = '2026-11-28T00:00:00.000Z';
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
    db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(CAROL.id, ALICE.id).run();
  });

  after(() => {
    for (const database of databases) database.close();
  });

  function wrapStatement(statement: TestStatement): TestStatement {
    return {
      bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
      first: <T>() => statement.first<T>(),
      all: async <T>() => ({ ...(await statement.all<T>()), success: true }) as { results: T[] },
      run: () => statement.run(),
    };
  }

  function envFor(): Bindings {
    const wrapped: TestDatabase = {
      prepare: (sql: string) => wrapStatement(db.prepare(sql)),
      batch: (statements: TestStatement[]) => db.batch(statements),
      exec: (sql: string) => db.exec(sql),
      close: () => db.close(),
    };
    return { DB: wrapped as unknown as Bindings['DB'], ENVIRONMENT: 'test' } as unknown as Bindings;
  }

  function appFor(viewer: User | null): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('user', viewer);
      await next();
    });
    app.route('/', searchRouter);
    return app;
  }

  async function seedPost(id: string, visibility: string, createdAt: string, mentions: string): Promise<void> {
    // The migration triggers index each post in search_documents, so the real
    // search query runs against the same data it sees in production.
    await db
      .prepare(
        `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, status, visibility, created_at)
         VALUES (?, ?, 'alice', ?, '[]', ?, 'published', ?, ?)`,
      )
      .bind(id, ALICE.id, `猫の${id}`, mentions, visibility, createdAt)
      .run();
  }

  async function postIds(viewer: User | null): Promise<string[]> {
    const response = await appFor(viewer).request(
      `http://localhost/search/v2?q=${encodeURIComponent('猫')}&tab=posts&limit=20`,
      {},
      envFor(),
    );
    assert.equal(response.status, 200, `search failed for ${viewer?.username ?? 'anonymous'}`);
    const body = (await response.json()) as { posts: Array<{ id: string; text: string }> };
    return body.posts.map((post) => post.id);
  }

  it('never returns private or direct posts to anonymous or unauthorised searchers', async () => {
    await seedPost('search-public', 'public', NOW, '[]');
    await seedPost('search-private', 'private', AFTER, '[]');
    await seedPost('search-direct', 'direct', LATER, JSON.stringify([{ username: 'bob', user_id: BOB.id }]));

    assert.deepEqual(await postIds(null), ['search-public']);
    // Carol follows Alice, so she may see the followers-only post but not the DM.
    assert.deepEqual(await postIds(CAROL), ['search-private', 'search-public']);
    // Bob is mentioned in the DM but does not follow Alice.
    assert.deepEqual(await postIds(BOB), ['search-direct', 'search-public']);
    assert.deepEqual(await postIds(ALICE), ['search-direct', 'search-private', 'search-public']);
  });
});
