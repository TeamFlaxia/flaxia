import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { LANGUAGE_AFFINITY_WEIGHT } from '../functions/lib/recommendation-scoring.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// Route modules still use extensionless relative imports for the Worker
// bundler; Node needs the same resolver shim as the other Hono-router tests.
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

const NOW = '2026-11-28T00:00:00.000Z';

function makeUser(id: string, language: string): User {
  return {
    id,
    email: `${id}@test.com`,
    username: id.replace('-', '_'),
    display_name: id,
    bio: '',
    language,
    created_at: NOW,
  };
}

// Authors and viewers are deliberately different users: For You hides a
// viewer's own ordinary posts, which would otherwise mask the affinity effect.
const AUTHOR_EN = makeUser('author-en', 'en');
const AUTHOR_JA = makeUser('author-ja', 'ja');
const VIEWER_EN = makeUser('viewer-en', 'en');
const VIEWER_JA = makeUser('viewer-ja', 'ja');

const databases: TestDatabase[] = [];
let db: TestDatabase;
let asOfMs: number;
let basePath: string;

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  // Migration 0002 seeds demo posts; keep the fixture isolated from them.
  db.prepare('DELETE FROM posts').run();
  for (const user of [AUTHOR_EN, AUTHOR_JA, VIEWER_EN, VIEWER_JA]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, language, created_at)
       VALUES (?, ?, '', ?, ?, '', ?, ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, user.language, NOW)
      .run();
  }

  // Pin `asOf` so freshness/popularity are identical across all requests in a
  // test. No follow history: the only viewer-dependent term is language.
  asOfMs = Date.now();
  basePath = `/posts/recommended?cursor=${encodeURIComponent(`,,,${asOfMs}`)}&limit=20`;

  // The English author's post is newer, so its raw base score is higher: the
  // affinity nudge must be what lets the Japanese post overtake it for a `ja`
  // viewer. Both texts sit in the same quality-score length bucket.
  seedPost({
    id: 'en-post',
    author: AUTHOR_EN,
    text: 'An English note about autumn leaves, long park walks and warm coffee.',
    createdAt: new Date(asOfMs - 1 * 3600_000).toISOString(),
  });
  seedPost({
    id: 'ja-post',
    author: AUTHOR_JA,
    text: 'A Japanese note about sushi, quiet shrines and the evening train ride.',
    createdAt: new Date(asOfMs - 2 * 3600_000).toISOString(),
  });
  // Strong engagement would rank this first if For You did not exclude remote
  // rows at the source.
  seedPost({
    id: 'remote-post',
    author: AUTHOR_JA,
    text: 'A federated note from a remote instance about distant galaxies.',
    createdAt: new Date(asOfMs - 30 * 60_000).toISOString(),
    remote: true,
    engagementHotness: 100,
  });
});

after(() => {
  for (const database of databases) database.close();
});

type SeedPost = {
  id: string;
  author: User;
  text: string;
  createdAt: string;
  remote?: boolean;
  engagementHotness?: number;
};

function seedPost(post: SeedPost): void {
  db.prepare(
    `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, parent_id, root_id, status, created_at,
       actor_id, visibility, engagement_hotness)
     VALUES (?, ?, ?, ?, '[]', '[]', NULL, NULL, 'published', ?, ?, 'public', ?)`,
  )
    .bind(
      post.id,
      post.remote ? '' : post.author.id,
      post.author.username,
      post.text,
      post.createdAt,
      post.remote ? 'https://social.example/users/remote' : null,
      post.engagementHotness ?? 1,
    )
    .run();
  if (post.remote) {
    db.prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, ?, ?)')
      .bind(post.id, 'social.example', 5, post.createdAt)
      .run();
  }
}

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

type FeedResponse = {
  posts: Array<{ id: string }>;
  base_scores?: Record<string, number>;
};

async function getFeed(viewer: User | null, clientRank = false): Promise<FeedResponse> {
  const path = `${basePath}${clientRank ? '&client_rank=1' : ''}`;
  const response = await appFor(viewer).request(`http://localhost${path}`, {}, envFor(db));
  assert.equal(response.status, 200, `${path} → ${response.status}: ${await response.clone().text()}`);
  return (await response.json()) as FeedResponse;
}

function ids(feed: FeedResponse): string[] {
  return feed.posts.map((post) => post.id);
}

describe('GET /api/posts/recommended — viewer language affinity', () => {
  it('lets a lower-base-score post by a Japanese author outrank a higher-base-score English post for a ja viewer', async () => {
    const guestBase = (await getFeed(null, true)).base_scores!;
    const gap = guestBase['en-post'] - guestBase['ja-post'];
    assert.ok(
      gap > 0 && gap < LANGUAGE_AFFINITY_WEIGHT,
      `fixture must leave room for the affinity nudge (base gap ${gap}, weight ${LANGUAGE_AFFINITY_WEIGHT})`,
    );

    assert.deepEqual(ids(await getFeed(VIEWER_JA)), ['ja-post', 'en-post']);
  });

  it('follows the viewer: an en viewer puts the English post first, a guest keeps raw base order', async () => {
    const guestBase = (await getFeed(null, true)).base_scores!;
    assert.deepEqual(ids(await getFeed(null)), ['en-post', 'ja-post']);
    assert.deepEqual(ids(await getFeed(VIEWER_EN)), ['en-post', 'ja-post']);

    // The boost is attached to posts whose author language matches the viewer,
    // and guests get no boost at all.
    const jaBase = (await getFeed(VIEWER_JA, true)).base_scores!;
    const enBase = (await getFeed(VIEWER_EN, true)).base_scores!;
    assert.ok(Math.abs(jaBase['ja-post'] - guestBase['ja-post'] - LANGUAGE_AFFINITY_WEIGHT) < 1e-9);
    assert.ok(Math.abs(jaBase['en-post'] - guestBase['en-post']) < 1e-9);
    assert.ok(Math.abs(enBase['en-post'] - guestBase['en-post'] - LANGUAGE_AFFINITY_WEIGHT) < 1e-9);
    assert.ok(Math.abs(enBase['ja-post'] - guestBase['ja-post']) < 1e-9);
  });

  it('still never returns federated posts, for any viewer or ranking path', async () => {
    for (const viewer of [null, VIEWER_EN, VIEWER_JA]) {
      for (const clientRank of [false, true]) {
        const feedIds = ids(await getFeed(viewer, clientRank)).sort();
        assert.deepEqual(
          feedIds,
          ['en-post', 'ja-post'],
          `federated posts belong to the Federated tab (client_rank=${clientRank})`,
        );
      }
    }
  });
});
