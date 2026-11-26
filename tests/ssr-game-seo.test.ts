// Game posts must keep their thumbnail/playable metadata when SSR reads the
// thread endpoint. Without those columns /thread and /arcade fall back to the
// generic OGP image and lose the no-JS preview. The route is exercised against
// a real migrated database instead of asserting on its SQL source text.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { Post } from '../shared/types/post.ts';
import { loadThread } from '../src/lib/ssr-data.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';
import { BASE_URL, seedUserAndLogin } from './helpers/setup.ts';

// Route modules use extensionless relative imports for the Worker bundler;
// resolve them under Node the same way the other behavioural DB tests do.
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

const { replies } = await import('../functions/api/routes/posts/replies.ts');

type AppEnv = { Bindings: Bindings; Variables: Variables };
type TestStatement = ReturnType<TestDatabase['prepare']>;

// The shared D1 adapter has no `success` flag, while the route checks it like
// real D1. Add the flag locally so the real handler can run against SQLite.
function wrapStatement(statement: TestStatement): TestStatement {
  return {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
    first: <T>() => statement.first<T>(),
    all: async <T>() => ({ ...(await statement.all<T>()), success: true }) as ReturnType<TestStatement['all']>,
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

const databases: TestDatabase[] = [];
after(() => {
  for (const database of databases) database.close();
});

function metaContent(html: string, attribute: 'property' | 'name', key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`${attribute}=["']${key}["']`, 'i').test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) return content[1];
  }
  return null;
}

function jsonLdImage(html: string): unknown {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    if (value['@type'] === 'BlogPosting' && value.image !== undefined) return value.image;
  }
  return undefined;
}

test('thread route serves the game thumbnail and description to SSR', async () => {
  const database = createTestDatabase();
  databases.push(database);
  // 0002 seeds demo posts; keep the fixture isolated from them.
  database.prepare('DELETE FROM posts').run();
  database
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, thumbnail_key, game_description, game_title, status, created_at, visibility)
       VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?, 'published', ?, 'public')`,
    )
    .bind(
      'game-1',
      'u1',
      'author',
      'A game',
      'thumbnail/game-1.png',
      'Playable in the browser',
      'A Game Title',
      '2026-11-26T00:00:00.000Z',
    )
    .run();

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', null);
    await next();
  });
  app.route('/', replies);

  const response = await app.request('http://localhost/posts/game-1/thread', {}, {
    DB: wrapDb(database),
  } as unknown as Bindings);
  assert.equal(response.status, 200, `the thread route failed: ${await response.clone().text()}`);
  const body = (await response.json()) as { root?: Record<string, unknown>; replies?: Array<Record<string, unknown>> };
  assert.equal(body.root?.thumbnail_key, 'thumbnail/game-1.png', 'the thread root must carry the game thumbnail');
  assert.equal(
    body.root?.game_description,
    'Playable in the browser',
    'the thread root must carry the game description',
  );
  // Ported from the main-side game_title expectation: the thread route must
  // expose game_title as a column on the seeded game post, not just in its SQL.
  assert.equal(body.root?.game_title, 'A Game Title', 'the thread root must carry the game title');
});

test('loadThread keeps game fields on root', async () => {
  const root = {
    id: 'game-1',
    text: 'A game',
    thumbnail_key: 'thumbnail/game-1.png',
    game_description: 'Playable in the browser',
  } as unknown as Post;
  const fetchFn = (async () =>
    new Response(JSON.stringify({ root, replies: [] }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  const thread = await loadThread(fetchFn, 'game-1');
  assert.equal(thread.root?.thumbnail_key, root.thumbnail_key, 'thumbnail_key must survive the load helper');
  assert.equal(
    (thread.root as unknown as Record<string, unknown> | null)?.game_description,
    'Playable in the browser',
    'game_description must survive the load helper',
  );
});

async function seedGamePost(): Promise<{ id: string; thumbnailKey: string; text: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const { cookie } = await seedUserAndLogin(`ssrgame${suffix}`);
  const prepared = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'game.zip', contentType: 'application/zip' }),
  });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const { postId } = (await prepared.json()) as { postId: string };

  const thumbnailKey = `thumbnail/${postId}.png`;
  const text = `game seo probe ${suffix}`;
  const committed = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, zipKey: `zip/${postId}.zip`, thumbnailKey, text, hashtags: [] }),
  });
  assert.equal(committed.status, 200, await committed.clone().text());
  return { id: postId, thumbnailKey, text };
}

test('live: game thread and arcade SEO use the seeded thumbnail', async () => {
  const { id, thumbnailKey } = await seedGamePost();
  const headers = { 'Accept-Language': 'en' };

  const apiResponse = await fetch(`${BASE_URL}/api/posts/${id}/thread`, { headers });
  assert.equal(apiResponse.status, 200, 'the seeded game must be readable through the thread API');
  const threadData = (await apiResponse.json()) as { root?: Record<string, unknown> };
  assert.equal(threadData.root?.thumbnail_key, thumbnailKey, 'the thread API must return thumbnail_key');
  assert.ok(
    Object.hasOwn(threadData.root ?? {}, 'game_description'),
    'the thread API must return game_description (null is fine, an omitted column is not)',
  );
  assert.ok(
    Object.hasOwn(threadData.root ?? {}, 'game_title'),
    'the thread API must return game_title (null is fine, an omitted column is not)',
  );

  const threadHtml = await (await fetch(`${BASE_URL}/thread/${id}`, { headers })).text();
  const threadImage = `https://flaxia.app/api/thumbnail/${encodeURIComponent(id)}`;
  assert.equal(metaContent(threadHtml, 'property', 'og:image'), threadImage, 'thread og:image must use the thumbnail');
  assert.equal(jsonLdImage(threadHtml), threadImage, 'BlogPosting image must match the thread og:image');
  assert.ok(threadHtml.includes(`/api/images/${thumbnailKey}`), 'the no-JS post card must render the game thumbnail');

  const arcadeHtml = await (await fetch(`${BASE_URL}/arcade/${id}`, { headers })).text();
  const arcadeImage = `https://flaxia.app/api/images/${encodeURIComponent(thumbnailKey)}`;
  assert.equal(metaContent(arcadeHtml, 'property', 'og:image'), arcadeImage, 'arcade og:image must use the thumbnail');
  assert.equal(jsonLdImage(arcadeHtml), arcadeImage, 'arcade BlogPosting image must match og:image');
});
