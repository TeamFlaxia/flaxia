import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// The route modules use extensionless relative imports for the Worker bundler;
// Node needs a resolver shim to load the same modules (same pattern as
// tests/post-visibility.test.ts).
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

const { recommendations } = await import('../functions/api/routes/posts/recommendations.ts');

// The shared D1 adapter's `all()` has no `success` flag, while enrichment
// helpers check it exactly like real D1. Add the flag locally.
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
const DAVE: User = {
  id: 'dave',
  email: 'dave@test.com',
  username: 'dave',
  display_name: 'Dave',
  bio: '',
  created_at: NOW,
};

const databases: TestDatabase[] = [];
let db: TestDatabase;

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  // Migration 0002 seeds demo posts; keep the fixture isolated from them.
  db.prepare('DELETE FROM posts').run();
  for (const user of [ALICE, BOB, CAROL, DAVE]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, NOW)
      .run();
  }
  // Carol follows Alice; Bob and Dave follow nobody.
  db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(CAROL.id, ALICE.id).run();
});

after(() => {
  for (const database of databases) database.close();
});

function envFor(database: TestDatabase): Bindings {
  return { DB: wrapDb(database) as unknown as Bindings['DB'] } as Bindings;
}

function appFor(viewer: User | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (viewer) c.set('user', viewer);
    await next();
  });
  app.route('/', recommendations);
  return app;
}

type Visibility = 'public' | 'unlisted' | 'private' | 'direct';

type SeedPost = {
  id: string;
  author?: User;
  text: string;
  visibility?: Visibility;
  mentions?: unknown[];
  omitVisibility?: boolean;
  createdAt?: string;
  remote?: boolean;
};

async function seedPost(post: SeedPost): Promise<void> {
  const author = post.author ?? ALICE;
  const createdAt = post.createdAt ?? new Date(Date.now() - 3600_000).toISOString();
  const visibility = post.omitVisibility ? null : (post.visibility ?? 'public');
  const bind: unknown[] = [
    post.id,
    post.remote ? '' : author.id,
    author.username,
    post.text,
    '[]',
    JSON.stringify(post.mentions ?? []),
    null,
    null,
    createdAt,
    post.remote ? 'https://social.example/users/remote' : null,
  ];
  if (!post.omitVisibility) bind.push(visibility);
  const columns = post.omitVisibility
    ? 'id, user_id, username, text, hashtags, mentions, parent_id, root_id, status, created_at, actor_id'
    : 'id, user_id, username, text, hashtags, mentions, parent_id, root_id, status, created_at, actor_id, visibility';
  const placeholders = post.omitVisibility
    ? "?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?"
    : "?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?";
  await db
    .prepare(`INSERT INTO posts (${columns}) VALUES (${placeholders})`)
    .bind(...bind)
    .run();
  if (post.remote) {
    await db
      .prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, ?, ?)')
      .bind(post.id, 'social.example', 5, createdAt)
      .run();
  }
}

/**
 * Public/unlisted plus private/direct (own, followed and mentioned). At most
 * two posts per author so the server path's per-author diversity cap cannot
 * hide a seeded post from the exact-set assertions.
 */
async function seedVisibilitySet(createdAt?: string): Promise<void> {
  const at = createdAt ?? new Date(Date.now() - 3600_000).toISOString();
  await seedPost({
    id: 'pri-alice',
    text: 'private note from alice about cherries',
    visibility: 'private',
    createdAt: at,
  });
  await seedPost({
    id: 'dir-alice',
    text: 'direct note for bob about figs',
    visibility: 'direct',
    mentions: [{ username: 'bob', user_id: BOB.id }],
    createdAt: at,
  });
  await seedPost({ id: 'pub-bob', author: BOB, text: 'public note from bob about apples', createdAt: at });
  await seedPost({
    id: 'unl-carol',
    author: CAROL,
    text: 'unlisted note from carol about grapes',
    visibility: 'unlisted',
    createdAt: at,
  });
  await seedPost({
    id: 'pri-bob',
    author: BOB,
    text: 'private note from bob about dates',
    visibility: 'private',
    createdAt: at,
  });
  await seedPost({
    id: 'legacy-dave',
    author: DAVE,
    text: 'legacy note from dave about honeydew',
    omitVisibility: true,
    createdAt: at,
  });
  await seedPost({ id: 'remote-pub', text: 'remote public note about honey', remote: true, createdAt: at });
}

// For You excludes the viewer's own ordinary posts (as in the existing
// posts.test.ts contract), but private/direct posts stay visible to their author.
const ANON_IDS = ['legacy-dave', 'pub-bob', 'remote-pub', 'unl-carol'];
const ALICE_IDS = ['dir-alice', 'legacy-dave', 'pri-alice', 'pub-bob', 'remote-pub', 'unl-carol'];
const BOB_IDS = ['dir-alice', 'legacy-dave', 'pri-bob', 'remote-pub', 'unl-carol'];
const CAROL_IDS = ['legacy-dave', 'pri-alice', 'pub-bob', 'remote-pub'];
const DAVE_IDS = ['pub-bob', 'remote-pub', 'unl-carol'];

const RECENT_PATHS = ['/posts/recommended?limit=20', '/posts/recommended?client_rank=1&limit=20'];

async function getIds(path: string, viewer: User | null): Promise<string[]> {
  const response = await appFor(viewer).request(`http://localhost${path}`, {}, envFor(db));
  assert.equal(response.status, 200, `${path} → ${response.status}: ${await response.clone().text()}`);
  const data = (await response.json()) as { posts: Array<{ id: string }> };
  return data.posts.map((post) => post.id).sort();
}

describe('GET /api/posts/recommended — visibility', () => {
  it('anonymous requests return only public/unlisted posts, never private or direct', async () => {
    await seedVisibilitySet();
    for (const path of RECENT_PATHS) {
      assert.deepEqual(await getIds(path, null), ANON_IDS, path);
    }
  });

  it('an authenticated author sees their own private and direct posts', async () => {
    await seedVisibilitySet();
    for (const path of RECENT_PATHS) {
      assert.deepEqual(await getIds(path, ALICE), ALICE_IDS, path);
    }
  });

  it('a follower sees a followed author private post but not a stranger private post', async () => {
    await seedVisibilitySet();
    for (const path of RECENT_PATHS) {
      assert.deepEqual(await getIds(path, CAROL), CAROL_IDS, path);
      assert.deepEqual(await getIds(path, DAVE), DAVE_IDS, path);
    }
  });

  it('a mentioned local user sees a direct post; other users do not', async () => {
    await seedVisibilitySet();
    for (const path of RECENT_PATHS) {
      const bobIds = await getIds(path, BOB);
      assert.deepEqual(bobIds, BOB_IDS, path);
      assert.ok(bobIds.includes('dir-alice'), `${path}: the mentioned user must see the direct post`);
      const carolIds = await getIds(path, CAROL);
      assert.ok(!carolIds.includes('dir-alice'), `${path}: an unmentioned follower must not see the direct post`);
      assert.ok(!(await getIds(path, null)).includes('dir-alice'), `${path}: anonymous must not see the direct post`);
    }
  });

  it('still excludes authors blocked by the viewer', async () => {
    await seedVisibilitySet();
    await seedPost({ id: 'blocked-public', author: DAVE, text: 'public note from blocked dave about honeydew' });
    db.prepare('INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').bind(ALICE.id, DAVE.id).run();

    const aliceWithoutDave = ALICE_IDS.filter((id) => id !== 'legacy-dave');
    for (const path of RECENT_PATHS) {
      assert.deepEqual(await getIds(path, ALICE), aliceWithoutDave, `${path}: blocked author must stay hidden`);
      assert.deepEqual(
        await getIds(path, BOB),
        [...BOB_IDS, 'blocked-public'].sort(),
        `${path}: non-blocking viewers keep the post`,
      );
    }
  });

  it('applies the same visibility rule on archive fallback and archive cursors', async () => {
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    await seedVisibilitySet(old);
    const paths = [
      '/posts/recommended?limit=20',
      '/posts/recommended?client_rank=1&limit=20',
      '/posts/recommended?cursor=archive&limit=20',
      '/posts/recommended?client_rank=1&cursor=archive&limit=20',
    ];
    for (const path of paths) {
      assert.deepEqual(await getIds(path, null), ANON_IDS, path);
      assert.deepEqual(await getIds(path, ALICE), ALICE_IDS, path);
      assert.deepEqual(await getIds(path, CAROL), CAROL_IDS, path);
      assert.deepEqual(await getIds(path, BOB), BOB_IDS, path);
    }
  });
});
