import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// The shared test adapter's `all()` has no `success` flag, while the route
// handlers check it exactly like real D1. Add the flag locally so the real
// handlers can run against the in-memory database.
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

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs a resolver shim to load the same modules for behavioural tests
// (same pattern as tests/auth-hot-path.test.ts).
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
const { manage } = await import('../functions/api/routes/posts/manage.ts');
const { replies } = await import('../functions/api/routes/posts/replies.ts');
const { composer } = await import('../functions/api/routes/posts/composer.ts');

type AppEnv = { Bindings: Bindings; Variables: Variables };

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

const databases: TestDatabase[] = [];
let db: TestDatabase;

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  // 0002 seeds demo posts; keep the fixture isolated from them.
  db.prepare('DELETE FROM posts').run();
  for (const user of [ALICE, BOB, CAROL]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, NOW)
      .run();
  }
  // Carol follows Alice; Bob does not.
  db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(CAROL.id, ALICE.id).run();
});

after(() => {
  for (const database of databases) database.close();
});

function envFor(database: TestDatabase): Bindings {
  return { DB: wrapDb(database) as unknown as Bindings['DB'] } as Bindings;
}

/** Mount a route under a test app that pre-populates the auth context. */
function appFor(route: Hono<AppEnv>, viewer: User | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (viewer) c.set('user', viewer);
    await next();
  });
  app.route('/', route);
  return app;
}

type SeedPost = {
  id: string;
  author?: User;
  text: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  mentions?: unknown[];
  hashtags?: string[];
  parentId?: string;
  rootId?: string;
  omitVisibility?: boolean;
  createdAt?: string;
};

async function seedPost(post: SeedPost): Promise<void> {
  const author = post.author ?? ALICE;
  const visibility = post.omitVisibility ? null : (post.visibility ?? 'public');
  const createdAt = post.createdAt ?? NOW;
  const bind: unknown[] = [
    post.id,
    author.id,
    author.username,
    post.text,
    JSON.stringify(post.hashtags ?? []),
    JSON.stringify(post.mentions ?? []),
    post.parentId ?? null,
    post.rootId ?? null,
    createdAt,
  ];
  if (!post.omitVisibility) bind.push(visibility);
  const columns = post.omitVisibility
    ? 'id, user_id, username, text, hashtags, mentions, parent_id, root_id, status, created_at'
    : 'id, user_id, username, text, hashtags, mentions, parent_id, root_id, status, created_at, visibility';
  const placeholders = post.omitVisibility
    ? "?, ?, ?, ?, ?, ?, ?, ?, 'published', ?"
    : "?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?";
  await db
    .prepare(`INSERT INTO posts (${columns}) VALUES (${placeholders})`)
    .bind(...bind)
    .run();
}

async function getIds(app: Hono<AppEnv>, path: string): Promise<{ ids: string[]; count?: number }> {
  const response = await app.request(`http://localhost${path}`, {}, envFor(db));
  assert.equal(response.status, 200, `${path} → ${response.status}: ${await response.clone().text()}`);
  const data = (await response.json()) as { posts: Array<{ id: string }>; count?: number };
  return { ids: data.posts.map((post) => post.id), count: data.count };
}

function feedApp(viewer: User | null): Hono<AppEnv> {
  return appFor(feed, viewer);
}

async function getReplyIds(app: Hono<AppEnv>, path: string): Promise<string[]> {
  const response = await app.request(`http://localhost${path}`, {}, envFor(db));
  assert.equal(response.status, 200, `${path} → ${response.status}: ${await response.clone().text()}`);
  const data = (await response.json()) as { replies: Array<{ id: string }> };
  return data.replies.map((post) => post.id);
}

describe('posts.visibility migration', () => {
  it('defaults every existing/new post to public', async () => {
    await seedPost({ id: 'legacy', author: BOB, text: 'legacy row', omitVisibility: true });
    await seedPost({ id: 'explicit', author: ALICE, text: 'explicit row' });
    const rows = await db
      .prepare('SELECT id, visibility FROM posts ORDER BY id')
      .all<{ id: string; visibility: string }>();
    assert.deepEqual(
      rows.results.map((row) => [row.id, row.visibility]),
      [
        ['explicit', 'public'],
        ['legacy', 'public'],
      ],
    );
    // Both must reach the anonymous global timeline.
    const { ids } = await getIds(feedApp(null), '/posts?limit=20');
    assert.deepEqual(ids.sort(), ['explicit', 'legacy']);
  });
});

describe('visibility in the chronological feed', () => {
  it('public and unlisted are visible to everyone', async () => {
    await seedPost({ id: 'public-1', text: 'a public post' });
    await seedPost({ id: 'unlisted-1', text: 'an unlisted post', visibility: 'unlisted' });

    for (const viewer of [null, BOB, CAROL, ALICE]) {
      const { ids } = await getIds(feedApp(viewer), '/posts?limit=20');
      assert.deepEqual(ids.sort(), ['public-1', 'unlisted-1']);
    }
  });

  it('private posts are visible only to the author and local followers', async () => {
    await seedPost({ id: 'private-1', text: 'followers only', visibility: 'private' });

    assert.deepEqual((await getIds(feedApp(null), '/posts?limit=20')).ids, []);
    assert.deepEqual((await getIds(feedApp(BOB), '/posts?limit=20')).ids, [], 'a stranger must not see it');
    assert.deepEqual((await getIds(feedApp(CAROL), '/posts?limit=20')).ids, ['private-1'], 'a follower sees it');
    assert.deepEqual((await getIds(feedApp(ALICE), '/posts?limit=20')).ids, ['private-1'], 'the author sees it');

    // Unfollow and the post disappears for the former follower.
    await db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(CAROL.id, ALICE.id).run();
    assert.deepEqual((await getIds(feedApp(CAROL), '/posts?limit=20')).ids, []);
  });

  it('direct posts are visible only to the author and mentioned local users', async () => {
    await seedPost({
      id: 'direct-1',
      text: 'just for bob',
      visibility: 'direct',
      mentions: [{ username: 'bob', user_id: BOB.id }],
    });

    assert.deepEqual((await getIds(feedApp(null), '/posts?limit=20')).ids, []);
    assert.deepEqual((await getIds(feedApp(CAROL), '/posts?limit=20')).ids, [], 'an unmentioned follower sees nothing');
    assert.deepEqual((await getIds(feedApp(BOB), '/posts?limit=20')).ids, ['direct-1']);
    assert.deepEqual((await getIds(feedApp(ALICE), '/posts?limit=20')).ids, ['direct-1']);
  });

  it('filters the hashtag result and its total count by visibility', async () => {
    await seedPost({ id: 'tag-public', text: 'one #visibility', hashtags: ['visibility'] });
    await seedPost({
      id: 'tag-private',
      text: 'two #visibility',
      hashtags: ['visibility'],
      visibility: 'private',
    });

    const anon = await getIds(feedApp(null), '/posts?hashtag=visibility&limit=20');
    assert.deepEqual(anon.ids, ['tag-public']);
    assert.equal(anon.count, 1);

    const follower = await getIds(feedApp(CAROL), '/posts?hashtag=visibility&limit=20');
    assert.deepEqual(follower.ids.sort(), ['tag-private', 'tag-public']);
    assert.equal(follower.count, 2);
  });

  it('returns the exact visible ids on every feed branch and cursor page', async () => {
    const at = (second: number) => `2026-11-26T00:00:0${second}.000Z`;
    await seedPost({ id: 'branch-1', text: 'branch one #visibility', hashtags: ['visibility'], createdAt: at(1) });
    await seedPost({
      id: 'branch-2',
      text: 'branch two #visibility',
      hashtags: ['visibility'],
      visibility: 'private',
      createdAt: at(2),
    });
    await seedPost({
      id: 'branch-3',
      text: 'branch three #visibility',
      hashtags: ['visibility'],
      visibility: 'direct',
      mentions: [{ username: 'carol', user_id: CAROL.id }],
      createdAt: at(3),
    });
    const app = feedApp(CAROL);
    const all = ['branch-1', 'branch-2', 'branch-3'];
    const cases: Array<[string, string[]]> = [
      ['/posts?limit=5', all],
      [`/posts?limit=5&cursor=${at(2)}`, ['branch-1']],
      [`/posts?limit=5&cursor=${at(4)}`, all],
      ['/posts?hashtag=visibility&limit=5', all],
      [`/posts?hashtag=visibility&limit=5&cursor=${at(2)}`, ['branch-1']],
      ['/posts?following=true&limit=5', all],
      [`/posts?following=true&limit=5&cursor=${at(2)}`, ['branch-1']],
      [`/posts?username=${ALICE.username}&limit=5`, all],
      [`/posts?username=${ALICE.username}&limit=5&cursor=${at(2)}`, ['branch-1']],
      ['/posts/trending?limit=5', all],
      [`/posts/trending?limit=5&cursor=999999,${at(2)},branch-1`, all],
    ];
    for (const [path, expected] of cases) {
      const result = await getIds(app, path);
      assert.deepEqual(result.ids.sort(), expected, path);
      // The hashtag total counts every visible match, even on a cursor page.
      if (path.includes('hashtag=')) assert.equal(result.count, all.length, path);
    }
  });
});

describe('visibility in other post listings', () => {
  it('hides private root posts and replies from users who cannot see them', async () => {
    await seedPost({ id: 'thread-root', text: 'private thread root', visibility: 'private' });
    await seedPost({
      id: 'thread-reply',
      text: 'private reply',
      visibility: 'private',
      parentId: 'thread-root',
      rootId: 'thread-root',
    });

    for (const route of [replies, manage]) {
      const stranger = appFor(route, BOB);
      const follower = appFor(route, CAROL);
      const repliesPath = route === replies ? '/posts/thread-root/replies' : '/posts/thread-root';
      assert.equal((await stranger.request(`http://localhost${repliesPath}`, {}, envFor(db))).status, 404);
      assert.equal((await follower.request(`http://localhost${repliesPath}`, {}, envFor(db))).status, 200);
    }

    const thread = await appFor(replies, BOB).request('http://localhost/posts/thread-root/thread', {}, envFor(db));
    assert.equal(thread.status, 404, 'a stranger cannot read the thread at all');
  });

  it('keeps replies cursor binds aligned with visibility params', async () => {
    await seedPost({ id: 'cursor-root', text: 'cursor root' });
    await seedPost({
      id: 'cursor-reply',
      text: 'cursor reply',
      visibility: 'private',
      parentId: 'cursor-root',
      rootId: 'cursor-root',
    });

    const app = appFor(replies, CAROL);
    const after = '2026-11-26T00:00:01.000Z';
    const response = await app.request(`http://localhost/posts/cursor-root/replies?cursor=${after}`, {}, envFor(db));
    assert.equal(response.status, 200, await response.clone().text());
    const data = (await response.json()) as { replies: Array<{ id: string }> };
    assert.deepEqual(
      data.replies.map((post) => post.id),
      ['cursor-reply'],
    );
  });

  it('hides direct replies from users who were not mentioned', async () => {
    await seedPost({ id: 'public-root', text: 'public root' });
    await seedPost({
      id: 'direct-reply',
      text: 'direct reply',
      visibility: 'direct',
      mentions: [{ username: 'bob', user_id: BOB.id }],
      parentId: 'public-root',
      rootId: 'public-root',
    });

    const bob = await getReplyIds(appFor(replies, BOB), '/posts/public-root/replies');
    assert.deepEqual(bob, ['direct-reply']);
    const carol = await getReplyIds(appFor(replies, CAROL), '/posts/public-root/replies');
    assert.deepEqual(carol, []);
  });
});

describe('visibility in search, discovery and personal lists', () => {
  it('search hides private posts from strangers but not followers', async () => {
    await seedPost({ id: 'search-private', text: 'uniquesearchtoken secret', visibility: 'private' });
    const { search } = await import('../functions/api/routes/posts/search.ts');

    const stranger = await appFor(search, null).request('http://localhost/search?q=uniquesearchtoken', {}, envFor(db));
    assert.equal(stranger.status, 200);
    const strangerData = (await stranger.json()) as { results: Array<{ id: string }> };
    assert.deepEqual(strangerData.results, []);

    const follower = appFor(search, CAROL);
    const allowed = await follower.request('http://localhost/search?q=uniquesearchtoken', {}, envFor(db));
    assert.equal(allowed.status, 200);
    const allowedData = (await allowed.json()) as { results: Array<{ id: string }> };
    assert.deepEqual(
      allowedData.results.map((post) => post.id),
      ['search-private'],
    );
  });

  it('bookmarks and freshs listings hide posts the viewer cannot see', async () => {
    await seedPost({ id: 'list-private', text: 'listed but private', visibility: 'private' });
    await db.prepare('INSERT INTO bookmarks (post_id, user_id) VALUES (?, ?)').bind('list-private', BOB.id).run();
    await db.prepare('INSERT INTO freshs (post_id, user_id) VALUES (?, ?)').bind('list-private', BOB.id).run();
    const { engagement } = await import('../functions/api/routes/posts/engagement.ts');

    for (const path of ['/bookmarks', '/freshs']) {
      const response = await appFor(engagement, BOB).request(`http://localhost${path}`, {}, envFor(db));
      assert.equal(response.status, 200, path);
      const data = (await response.json()) as { posts: Array<{ id: string }> };
      assert.deepEqual(data.posts, [], path);
    }
  });

  it('similar-post discovery respects the viewer', async () => {
    await seedPost({ id: 'sim-source', text: 'similar source' });
    await seedPost({ id: 'sim-private', text: 'similar private', visibility: 'private' });
    for (const id of ['sim-source', 'sim-private']) {
      await db
        .prepare(
          'INSERT INTO post_embeddings (post_id, embedding, dimensions, model, created_at) VALUES (?, ?, 2, ?, ?)',
        )
        .bind(id, '[1,0]', 'test', NOW)
        .run();
    }
    const { discovery } = await import('../functions/api/routes/posts/discovery.ts');

    const stranger = await appFor(discovery, BOB).request('http://localhost/posts/sim-source/similar', {}, envFor(db));
    assert.equal(stranger.status, 200);
    assert.deepEqual(((await stranger.json()) as { posts: Array<{ id: string }> }).posts, []);

    const follower = await appFor(discovery, CAROL).request(
      'http://localhost/posts/sim-source/similar',
      {},
      envFor(db),
    );
    assert.equal(follower.status, 200);
    assert.deepEqual(
      ((await follower.json()) as { posts: Array<{ id: string }> }).posts.map((post) => post.id),
      ['sim-private'],
    );
  });
});

describe('composer submit', () => {
  it('rejects an invalid visibility value with 422 before writing a post', async () => {
    const app = appFor(composer, ALICE);
    const json = await app.request(
      'http://localhost/posts/commit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: 'invalid-vis-json', text: 'hello', visibility: 'sideways' }),
      },
      envFor(db),
    );
    assert.equal(json.status, 422);
    assert.deepEqual(await json.json(), { error: 'Invalid visibility' });

    const form = new FormData();
    form.set('text', 'hello');
    form.set('visibility', 'sideways');
    const multipart = await app.request('http://localhost/posts/commit', { method: 'POST', body: form }, envFor(db));
    assert.equal(multipart.status, 422);
    assert.deepEqual(await multipart.json(), { error: 'Invalid visibility' });

    assert.equal(
      await db.prepare('SELECT id FROM posts WHERE id = ?').bind('invalid-vis-json').first(),
      null,
      'an invalid visibility must not create a post',
    );
  });

  it('sends visibility on the JSON path, the FormData path, and defaults to public', async () => {
    const { submitPost } = await import('../src/lib/composer/submit.ts');
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ post: { id: 'new-post' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const base = { selectedFile: null, selectedMedia: [], selectedThumbnail: null, poll: null };
      await submitPost({ ...base, text: 'json path', visibility: 'private' });
      const json = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
      assert.equal(json.visibility, 'private');

      await submitPost({ ...base, text: 'default path' });
      const defaultJson = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
      assert.equal(defaultJson.visibility, 'public', 'existing callers keep the public default');

      await submitPost({
        ...base,
        text: 'form path',
        selectedThumbnail: new File(['x'], 'thumb.png', { type: 'image/png' }),
        visibility: 'direct',
      });
      const form = calls[2].init?.body as FormData;
      assert.equal(form.get('visibility'), 'direct');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
