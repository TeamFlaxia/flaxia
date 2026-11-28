import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs the same resolver shim used by the other games test suites.
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

const { authMiddleware } = await import('../functions/api/helpers.ts');
const games = (await import('../functions/api/routes/games.ts')).default;
const { servePublicLoader } = await import('../functions/lib/game-loader-public.ts');

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

type AppEnv = { Bindings: Bindings; Variables: Variables };

const NOW = '2026-11-26T00:00:00.000Z';
const AFTER = '2026-11-27T00:00:00.000Z';
const EXPIRES = '2099-01-01T00:00:00.000Z';

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
let kv: Map<string, string>;

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  kv = new Map();
  for (const user of [ALICE, BOB, CAROL]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, NOW)
      .run();
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(`${user.id}-session`, user.id, EXPIRES)
      .run();
  }
  // Carol follows Alice; Bob does not.
  db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(CAROL.id, ALICE.id).run();
});

after(() => {
  for (const database of databases) database.close();
});

function envFor(): Bindings {
  return {
    DB: wrapDb(db) as unknown as Bindings['DB'],
    CACHE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    } as unknown as Bindings['CACHE'],
  } as Bindings;
}

/** Mount the real games router behind the real auth middleware. */
function appFor(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('/api/*', authMiddleware);
  app.route('/api', games);
  // Media keeps its unauthenticated hot path.
  app.get('/api/images/:key', (c) => c.json({ user: c.get('user')?.id ?? null }));
  return app;
}

function cookieFor(user: User): Record<string, string> {
  return { Cookie: `session=${user.id}-session` };
}

async function get(path: string, viewer?: User): Promise<{ status: number; body: unknown; text: string }> {
  const response = await appFor().request(
    `http://localhost${path}`,
    { headers: viewer ? cookieFor(viewer) : {} },
    envFor(),
  );
  const text = await response.clone().text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

function gameIdsOf(body: unknown): string[] {
  const rows = (body as { games: Array<{ id: string; postId: string }> }).games ?? [];
  return rows.map((row) => row.id ?? row.postId).sort();
}

function gameById(body: unknown): Record<string, Record<string, unknown>> {
  const rows = (body as { games: Array<Record<string, unknown>> }).games ?? [];
  return Object.fromEntries(rows.map((row) => [String(row.id), row]));
}

type SeedGame = {
  id: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  mentions?: Array<{ username: string; user_id: string }>;
  createdAt?: string;
};

async function seedGame(game: SeedGame): Promise<void> {
  const columns = ['id', 'user_id', 'username', 'text', 'hashtags', 'mentions', 'status', 'created_at', 'visibility'];
  const values: unknown[] = [
    game.id,
    ALICE.id,
    ALICE.username,
    `GAME ${game.id}`,
    '[]',
    JSON.stringify(game.mentions ?? []),
    'published',
    game.createdAt ?? NOW,
    game.visibility ?? 'public',
  ];
  columns.push('payload_key');
  values.push(`zip/${game.id}.zip`);
  await db
    .prepare(`INSERT INTO posts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .bind(...values)
    .run();
}

async function seedGames(): Promise<void> {
  await seedGame({ id: 'game-public' });
  await seedGame({ id: 'game-private', visibility: 'private', createdAt: AFTER });
  await seedGame({
    id: 'game-direct',
    visibility: 'direct',
    mentions: [{ username: BOB.username, user_id: BOB.id }],
    createdAt: '2026-11-28T00:00:00.000Z',
  });
}

describe('/api/games session resolution', () => {
  // Each request starts without a cached response so the test exercises the
  // fresh DB query whose visibility predicate depends on the resolved viewer.
  async function getFresh(path: string, viewer?: User) {
    kv.delete('games:recent:20:first');
    return get(path, viewer);
  }

  it('uses the viewer resolved by authMiddleware for recommended mode', async () => {
    await seedGames();

    const anon = await getFresh('/api/games?recommended=true&limit=20');
    assert.equal(anon.status, 200, anon.text);
    assert.deepEqual(gameIdsOf(anon.body), ['game-public']);
    assert.equal(anon.text.includes('GAME game-private'), false);

    const stranger = await getFresh('/api/games?recommended=true&limit=20', BOB);
    assert.deepEqual(gameIdsOf(stranger.body), ['game-direct', 'game-public']);
    assert.equal(stranger.text.includes('GAME game-private'), false);

    const follower = await getFresh('/api/games?recommended=true&limit=20', CAROL);
    assert.deepEqual(gameIdsOf(follower.body), ['game-private', 'game-public']);
    assert.equal(follower.text.includes('GAME game-private'), true, 'the accepted follower may read the game');

    const author = await getFresh('/api/games?recommended=true&limit=20', ALICE);
    assert.deepEqual(gameIdsOf(author.body), ['game-direct', 'game-private', 'game-public']);
  });

  it('keeps the public media GET hot path unauthenticated', async () => {
    const response = await appFor().request(
      'http://localhost/api/images/public.png',
      { headers: cookieFor(ALICE) },
      envFor(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: null });
  });
});

describe('/api/games shared KV cache isolation', () => {
  it('re-applies visibility for each viewer without leaking cached private games', async () => {
    await seedGames();

    // Prime the viewer-agnostic cache as the author: it now holds every game.
    const primed = await get('/api/games?limit=20', ALICE);
    assert.equal(primed.status, 200, primed.text);
    assert.deepEqual(gameIdsOf(primed.body), ['game-direct', 'game-private', 'game-public']);
    assert.ok(kv.has('games:recent:20:first'), 'the games cache entry was written');

    const anon = await get('/api/games?limit=20');
    assert.deepEqual(gameIdsOf(anon.body), ['game-public'], 'anonymous must not get the cached private games');
    assert.equal(anon.text.includes('GAME game-private'), false);
    assert.equal(anon.text.includes('GAME game-direct'), false);

    const stranger = await get('/api/games?limit=20', BOB);
    assert.deepEqual(gameIdsOf(stranger.body), ['game-direct', 'game-public']);
    assert.equal(stranger.text.includes('GAME game-private'), false);

    const follower = await get('/api/games?limit=20', CAROL);
    assert.deepEqual(gameIdsOf(follower.body), ['game-private', 'game-public']);
    assert.equal(follower.text.includes('GAME game-direct'), false);

    const author = await get('/api/games?limit=20', ALICE);
    assert.deepEqual(gameIdsOf(author.body), ['game-direct', 'game-private', 'game-public']);
  });

  it('restores isFreshed/isBookmarked for the current viewer on a cache hit', async () => {
    await seedGames();
    await get('/api/games?limit=20', ALICE); // prime the shared cache

    db.prepare('INSERT INTO freshs (post_id, user_id) VALUES (?, ?)').bind('game-private', CAROL.id).run();
    db.prepare('INSERT INTO bookmarks (post_id, user_id) VALUES (?, ?)').bind('game-public', CAROL.id).run();

    const follower = await get('/api/games?limit=20', CAROL);
    const gamesById = gameById(follower.body);
    assert.equal(gamesById['game-private']?.isFreshed, true);
    assert.equal(gamesById['game-public']?.isBookmarked, true);
    assert.equal(gamesById['game-public']?.isFreshed, false);
    assert.equal(gamesById['game-private']?.isBookmarked, false);

    const stranger = await get('/api/games?limit=20', BOB);
    assert.equal(gameById(stranger.body)['game-public']?.isBookmarked, false, 'bookmarks must not cross viewers');
  });
});

describe('public game loader audience', () => {
  const bucket = {
    head: async () => ({ etag: 'etag-1', size: 3 }),
    get: async () => ({ body: new Uint8Array([1, 2, 3]), size: 3, etag: 'etag-1' }),
  } as unknown as R2Bucket;

  function loaderApp(): Hono<{ Bindings: Bindings }> {
    const app = new Hono<{ Bindings: Bindings }>();
    app.get('/api/game-loader/:postId', (c) => servePublicLoader(c));
    app.get('/api/game-loader/:postId/archive', (c) => servePublicLoader(c));
    return app;
  }

  async function seedLoaderPost(
    id: string,
    options: { visibility?: string | null; hidden?: number; status?: string } = {},
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, status, hidden,
           created_at, visibility, payload_key)
         VALUES (?, ?, 'alice', 'LOADER SECRET', '[]', '[]', ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        ALICE.id,
        options.status ?? 'published',
        options.hidden ?? 0,
        NOW,
        options.visibility === undefined ? 'public' : options.visibility,
        `zip/${id}.zip`,
      )
      .run();
  }

  async function fetchLoader(path: string): Promise<Response> {
    return loaderApp().request(`https://sandbox.example${path}`, {}, {
      ...envFor(),
      BUCKET: bucket,
    } as Bindings);
  }

  it('404s private and direct games on both the descriptor and archive endpoints', async () => {
    await seedLoaderPost('game-public');
    await seedLoaderPost('game-unlisted', { visibility: 'unlisted' });
    await seedLoaderPost('game-private', { visibility: 'private' });
    await seedLoaderPost('game-direct', { visibility: 'direct' });
    await seedLoaderPost('game-hidden', { hidden: 1 });
    await seedLoaderPost('game-draft', { status: 'pending' });

    for (const id of ['game-public', 'game-unlisted']) {
      const response = await fetchLoader(`/api/game-loader/${id}`);
      assert.equal(response.status, 200, `${id}: ${await response.clone().text()}`);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const descriptor = (await response.json()) as { archiveUrl: string };
      const archive = await fetchLoader(
        new URL(descriptor.archiveUrl).pathname + new URL(descriptor.archiveUrl).search,
      );
      assert.equal(archive.status, 200, `${id} archive: ${await archive.clone().text()}`);
      assert.equal(archive.headers.get('Cache-Control'), 'no-store');
    }

    for (const id of ['game-private', 'game-direct', 'game-hidden', 'game-draft']) {
      const descriptor = await fetchLoader(`/api/game-loader/${id}`);
      assert.equal(descriptor.status, 404, `${id} descriptor`);
      assert.equal(descriptor.headers.get('Cache-Control'), 'no-store');
      const archive = await fetchLoader(`/api/game-loader/${id}/archive`);
      assert.equal(archive.status, 404, `${id} archive`);
      assert.equal(archive.headers.get('Cache-Control'), 'no-store');
    }
  });
});
