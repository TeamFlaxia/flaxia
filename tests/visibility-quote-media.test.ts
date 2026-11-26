import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, PostRow, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs the same resolver shim the other behavioural suites use.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.')
      ) {
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      }
      throw error;
    }
  },
});

const { default: media } = await import('../functions/api/routes/media.ts');
const { feed } = await import('../functions/api/routes/posts/feed.ts');
const { enrichPostsWithQuotes } = await import('../functions/api/feed-enrichment.ts');
const { enrichFeedPosts } = await import('../functions/api/routes/posts/helpers.ts');

type AppEnv = { Bindings: Bindings; Variables: Variables };
type TestStatement = ReturnType<TestDatabase['prepare']>;

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

// D1's all() carries a success flag; the shared SQLite adapter omits it, so
// wrap it exactly like tests/post-visibility.test.ts does.
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

const MEDIA_BYTES = 'MEDIA_BYTES';

function envFor(database: TestDatabase, reads: string[] = []): Bindings {
  const kv = new Map<string, string>();
  return {
    DB: wrapDb(database) as unknown as Bindings['DB'],
    CACHE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
    BUCKET: {
      async get(key: string) {
        reads.push(key);
        return {
          body: MEDIA_BYTES,
          size: MEDIA_BYTES.length,
          httpEtag: 'etag-1',
          httpMetadata: { contentType: 'image/png' },
        };
      },
    },
    BASE_URL: 'http://localhost',
  } as unknown as Bindings;
}

const users = [ALICE, BOB, CAROL, DAVE];

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  db.prepare('DELETE FROM posts').run();
  for (const user of users) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(user.id, user.email, user.username, user.display_name, NOW)
      .run();
    // Real session cookies: media GETs use the hot-path auth middleware, which
    // does not populate c.get('user') for image/audio/video/document requests.
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(`sess-${user.id}`, user.id, '2999-01-01T00:00:00.000Z')
      .run();
  }
  // Carol follows Bob; Dave does not. Dave is mentioned in Bob's direct post.
  db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(CAROL.id, BOB.id).run();
});

after(() => {
  for (const database of databases) database.close();
});

type SeedPost = {
  id: string;
  author?: User;
  text: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  mentions?: Array<{ username: string; user_id: string }>;
  quotedPostId?: string;
  hidden?: boolean;
  status?: 'published' | 'pending';
  thumbnailKey?: string;
};

async function seedPost(post: SeedPost): Promise<void> {
  const author = post.author ?? ALICE;
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, quoted_post_id, status, hidden, visibility, thumbnail_key, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      post.id,
      author.id,
      author.username,
      post.text,
      JSON.stringify(post.mentions ?? []),
      post.quotedPostId ?? null,
      post.status ?? 'published',
      post.hidden ? 1 : 0,
      post.visibility ?? 'public',
      post.thumbnailKey ?? null,
      NOW,
    )
    .run();
}

async function attach(postId: string, key: string, kind: 'image' | 'audio' | 'video' | 'document', position: number) {
  await db
    .prepare('INSERT INTO post_attachments (post_id, r2_key, kind, position) VALUES (?, ?, ?, ?)')
    .bind(postId, key, kind, position)
    .run();
}

type FeedPost = {
  id: string;
  text: string;
  quoted_post_id: string | null;
  quoted_post: { id: string; text: string; attachments?: unknown[] } | null;
};

async function feedPosts(viewer: User | null): Promise<Map<string, FeedPost>> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', viewer);
    await next();
  });
  app.route('/', feed);
  const response = await app.request('http://localhost/posts?limit=20', {}, envFor(db));
  assert.equal(response.status, 200, await response.clone().text());
  const data = (await response.json()) as { posts: FeedPost[] };
  return new Map(data.posts.map((post) => [post.id, post]));
}

async function seedQuoteFixture(): Promise<void> {
  await seedPost({ id: 'private-origin', author: BOB, text: 'PRIVATE_QUOTE_SECRET', visibility: 'private' });
  await seedPost({
    id: 'direct-origin',
    author: BOB,
    text: 'DIRECT_QUOTE_SECRET',
    visibility: 'direct',
    mentions: [{ username: DAVE.username, user_id: DAVE.id }],
  });
  await seedPost({ id: 'public-origin', text: 'PUBLIC_QUOTE_VISIBLE' });
  await seedPost({ id: 'quoter-private', text: 'quoting a private post', quotedPostId: 'private-origin' });
  await seedPost({ id: 'quoter-direct', text: 'quoting a direct post', quotedPostId: 'direct-origin' });
  await seedPost({ id: 'quoter-public', text: 'quoting a public post', quotedPostId: 'public-origin' });
}

describe('quoted post visibility', () => {
  it('does not embed private/direct quoted content for anonymous or unauthorised viewers', async () => {
    await seedQuoteFixture();

    const anonymous = await feedPosts(null);
    assert.equal(anonymous.get('quoter-private')?.quoted_post_id, 'private-origin', 'quote id stays as a placeholder');
    assert.equal(anonymous.get('quoter-private')?.quoted_post, null, 'anonymous must not see the private quote card');
    assert.equal(anonymous.get('quoter-direct')?.quoted_post, null, 'anonymous must not see the direct quote card');
    const anonymousJson = JSON.stringify([...anonymous.values()]);
    assert.ok(!anonymousJson.includes('PRIVATE_QUOTE_SECRET'), 'private text leaked anonymously');
    assert.ok(!anonymousJson.includes('DIRECT_QUOTE_SECRET'), 'direct text leaked anonymously');
    assert.equal(
      anonymous.get('quoter-public')?.quoted_post?.text,
      'PUBLIC_QUOTE_VISIBLE',
      'public quotes must still render',
    );

    const stranger = await feedPosts(DAVE);
    assert.equal(stranger.get('quoter-private')?.quoted_post, null, 'a stranger must not see the private quote');
    assert.ok(!JSON.stringify([...stranger.values()]).includes('PRIVATE_QUOTE_SECRET'));

    const follower = await feedPosts(CAROL);
    assert.equal(follower.get('quoter-private')?.quoted_post?.text, 'PRIVATE_QUOTE_SECRET');
    assert.equal(follower.get('quoter-direct')?.quoted_post, null, 'a follower is not a direct-message recipient');

    const author = await feedPosts(BOB);
    assert.equal(author.get('quoter-private')?.quoted_post?.text, 'PRIVATE_QUOTE_SECRET');
    assert.equal(author.get('quoter-direct')?.quoted_post?.text, 'DIRECT_QUOTE_SECRET');

    const mentioned = await feedPosts(DAVE);
    assert.equal(mentioned.get('quoter-direct')?.quoted_post?.text, 'DIRECT_QUOTE_SECRET');
  });

  it('enrichFeedPosts forwards the viewer to quote enrichment', async () => {
    await seedQuoteFixture();
    const rows = [{ id: 'quoter-private', quoted_post_id: 'private-origin' }] as unknown as PostRow[];
    const database = wrapDb(db) as unknown as D1Database;

    await enrichFeedPosts(rows, database, null);
    assert.equal(rows[0].quoted_post, null, 'an anonymous trending page must not embed the private quote');

    await enrichFeedPosts(rows, database, CAROL.id);
    assert.equal(rows[0].quoted_post?.text, 'PRIVATE_QUOTE_SECRET', 'the follower must still see the quote');
  });

  it('fails closed when enrichPostsWithQuotes is called without a viewer', async () => {
    await seedPost({ id: 'solo-private', author: BOB, text: 'UNSEEN_QUOTE_SECRET', visibility: 'private' });
    await seedPost({ id: 'solo-quoter', text: 'solo quote', quotedPostId: 'solo-private' });
    const rows = [{ id: 'solo-quoter', quoted_post_id: 'solo-private' } as unknown as PostRow];
    const database = wrapDb(db) as unknown as D1Database;

    await enrichPostsWithQuotes(rows, database);
    assert.equal(rows[0].quoted_post, null, 'no viewer must never expose a private quoted post');

    await enrichPostsWithQuotes(rows, database, BOB.id);
    assert.equal(rows[0].quoted_post?.text, 'UNSEEN_QUOTE_SECRET', 'the author can still see their quote');
  });
});

async function seedMediaFixture(): Promise<void> {
  await seedPost({ id: 'private-media', author: BOB, text: 'private media', visibility: 'private' });
  await seedPost({
    id: 'direct-media',
    author: BOB,
    text: 'direct media',
    visibility: 'direct',
    mentions: [{ username: DAVE.username, user_id: DAVE.id }],
  });
  await seedPost({ id: 'public-media', text: 'public media' });
  await seedPost({ id: 'hidden-media', text: 'hidden media', hidden: true });
  await seedPost({ id: 'zip-private', author: BOB, text: 'private game', visibility: 'private' });
  await seedPost({
    id: 'thumb-private',
    author: BOB,
    text: 'private thumbnail',
    visibility: 'private',
    thumbnailKey: 'gif/thumb-private/thumb.png',
  });
  await seedPost({
    id: 'swf-direct',
    author: BOB,
    text: 'direct swf',
    visibility: 'direct',
    mentions: [{ username: DAVE.username, user_id: DAVE.id }],
  });
  await attach('private-media', 'gif/private-media/1.png', 'image', 1);
  await attach('private-media', 'audio/private-media/1.mp3', 'audio', 2);
  await attach('direct-media', 'docs/direct-media/1.pdf', 'document', 1);
  await attach('public-media', 'gif/public-media/1.png', 'image', 1);
  await attach('hidden-media', 'gif/hidden-media/1.png', 'image', 1);
}

async function mediaGet(
  path: string,
  viewer: User | null,
  init: RequestInit = {},
): Promise<{ response: Response; reads: string[] }> {
  const reads: string[] = [];
  const headers = new Headers(init.headers);
  if (viewer) headers.set('Cookie', `session=sess-${viewer.id}`);
  const app = new Hono<AppEnv>();
  app.route('/api', media);
  const response = await app.request(`http://localhost${path}`, { ...init, headers }, envFor(db, reads));
  return { response, reads };
}

function assertNoPublicCache(response: Response): void {
  const cacheControl = response.headers.get('Cache-Control');
  assert.ok(cacheControl, 'non-public media must set an explicit Cache-Control');
  assert.doesNotMatch(cacheControl, /public/, `Cache-Control must not be public: ${cacheControl}`);
  assert.match(cacheControl, /private/, `Cache-Control must be private: ${cacheControl}`);
  assert.match(cacheControl, /no-store/, `Cache-Control must be no-store: ${cacheControl}`);
}

describe('private/direct media authorization', () => {
  beforeEach(async () => {
    await seedMediaFixture();
  });

  it('hides an attachment of a private post but serves it to the author and followers', async () => {
    const path = '/api/images/gif/private-media/1.png';

    const anonymous = await mediaGet(path, null);
    assert.equal(anonymous.response.status, 404, await anonymous.response.clone().text());
    assert.deepEqual(await anonymous.response.json(), { error: 'Image not found' });
    assert.deepEqual(anonymous.reads, [], 'no R2 read for an unauthorised request');
    assert.doesNotMatch(anonymous.response.headers.get('Cache-Control') ?? '', /public/);

    const stranger = await mediaGet(path, DAVE);
    assert.equal(stranger.response.status, 404, await stranger.response.clone().text());
    assert.deepEqual(stranger.reads, []);

    const follower = await mediaGet(path, CAROL);
    assert.equal(follower.response.status, 200, await follower.response.clone().text());
    assert.equal(await follower.response.text(), MEDIA_BYTES);
    assert.deepEqual(follower.reads, ['gif/private-media/1.png']);
    assertNoPublicCache(follower.response);

    const author = await mediaGet(path, BOB);
    assert.equal(author.response.status, 200, await author.response.clone().text());
    assertNoPublicCache(author.response);
  });

  it('hides a direct document from unmentioned users and gives mentioned users a private response', async () => {
    const path = '/api/documents/docs/direct-media/1.pdf';

    for (const viewer of [null, CAROL]) {
      const denied = await mediaGet(path, viewer);
      assert.equal(denied.response.status, 404, await denied.response.clone().text());
      assert.deepEqual(await denied.response.json(), { error: 'Document not found' });
      assert.deepEqual(denied.reads, []);
    }

    const mentioned = await mediaGet(path, DAVE);
    assert.equal(mentioned.response.status, 200, await mentioned.response.clone().text());
    assert.equal(await mentioned.response.text(), MEDIA_BYTES);
    // PDFs keep their existing inline-viewing disposition; only visibility and
    // cacheability change here.
    assert.equal(mentioned.response.headers.get('Content-Disposition'), 'inline');
    assertNoPublicCache(mentioned.response);

    const author = await mediaGet(path, BOB);
    assert.equal(author.response.status, 200, await author.response.clone().text());
    assertNoPublicCache(author.response);
  });

  it('applies the same rule to post-addressed ZIP, thumbnail and SWF routes', async () => {
    const cases: Array<{ path: string; denied: Array<User | null>; allowed: User; bytes: string }> = [
      { path: '/api/zip/zip-private', denied: [null, DAVE], allowed: CAROL, bytes: MEDIA_BYTES },
      { path: '/api/thumbnail/thumb-private', denied: [null, DAVE], allowed: CAROL, bytes: MEDIA_BYTES },
      { path: '/api/swf/swf-direct', denied: [null, CAROL], allowed: DAVE, bytes: MEDIA_BYTES },
    ];
    for (const { path, denied, allowed, bytes } of cases) {
      for (const viewer of denied) {
        const response = await mediaGet(path, viewer);
        assert.equal(response.response.status, 404, `${path}: ${await response.response.clone().text()}`);
        assert.deepEqual(response.reads, [], `${path}: no R2 read before authorization`);
        assert.doesNotMatch(response.response.headers.get('Cache-Control') ?? '', /public/);
      }
      const granted = await mediaGet(path, allowed);
      assert.equal(granted.response.status, 200, `${path}: ${await granted.response.clone().text()}`);
      assert.equal(await granted.response.text(), bytes, path);
      assertNoPublicCache(granted.response);
    }
  });

  it('does not let ranged audio responses keep a public cache header', async () => {
    const path = '/api/audio/audio/private-media/1.mp3';
    const anonymous = await mediaGet(path, null, { headers: { Range: 'bytes=0-3' } });
    assert.equal(anonymous.response.status, 404, await anonymous.response.clone().text());
    assert.deepEqual(anonymous.reads, []);

    const author = await mediaGet(path, BOB, { headers: { Range: 'bytes=0-3' } });
    assert.equal(author.response.status, 206, await author.response.clone().text());
    assertNoPublicCache(author.response);
  });

  it('keeps genuinely public and merely moderated media correctly cached', async () => {
    const publicMedia = await mediaGet('/api/images/gif/public-media/1.png', null);
    assert.equal(publicMedia.response.status, 200, await publicMedia.response.clone().text());
    assert.match(publicMedia.response.headers.get('Cache-Control') ?? '', /^public, max-age=300, s-maxage=300/);

    const hiddenAnonymous = await mediaGet('/api/images/gif/hidden-media/1.png', null);
    assert.equal(hiddenAnonymous.response.status, 404, await hiddenAnonymous.response.clone().text());
    assert.deepEqual(hiddenAnonymous.reads, []);

    const hiddenOwner = await mediaGet('/api/images/gif/hidden-media/1.png', ALICE);
    assert.equal(hiddenOwner.response.status, 200, await hiddenOwner.response.clone().text());
    assertNoPublicCache(hiddenOwner.response);
  });
});
