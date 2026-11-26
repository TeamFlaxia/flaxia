import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// Mirror the real D1 `success` flag so the production handlers can run against
// the in-memory SQLite adapter (same pattern as tests/post-visibility.test.ts).
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

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs a resolver shim to load the same modules for behavioural tests.
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

const { profiles } = await import('../functions/api/routes/users/profiles.ts');
const games = (await import('../functions/api/routes/games.ts')).default;
const currentTopic = (await import('../functions/api/routes/current-topic.ts')).default;
const tags = (await import('../functions/api/routes/tags.ts')).default;
const polls = (await import('../functions/api/routes/polls.ts')).default;

type AppEnv = { Bindings: Bindings; Variables: Variables };

const NOW = '2026-11-26T00:00:00.000Z';
const AFTER = '2026-11-27T00:00:00.000Z';

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
    // Poll reads resolve the viewer from the session cookie, not the Hono
    // context, so give every test user a live local session.
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(`${user.id}-session`, user.id, '2099-01-01T00:00:00.000Z')
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
    c.set('user', viewer);
    await next();
  });
  app.route('/', route);
  return app;
}

function cookieFor(user: User): Record<string, string> {
  return { Cookie: `session=${user.id}-session` };
}

async function requestJson(
  app: Hono<AppEnv>,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await app.request(`http://localhost${path}`, init, envFor(db));
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

type SeedPost = {
  id: string;
  author?: User;
  text: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  omitVisibility?: boolean;
  hashtags?: string[];
  mentions?: Array<{ username: string; user_id?: string }>;
  payloadKey?: string;
  swfKey?: string;
  actorId?: string;
  createdAt?: string;
};

async function seedPost(post: SeedPost): Promise<void> {
  const author = post.author ?? ALICE;
  const columns = ['id', 'user_id', 'username', 'text', 'hashtags', 'mentions', 'status', 'created_at'];
  const values: unknown[] = [
    post.id,
    author.id,
    author.username,
    post.text,
    JSON.stringify(post.hashtags ?? []),
    JSON.stringify(post.mentions ?? []),
    'published',
    post.createdAt ?? NOW,
  ];
  if (!post.omitVisibility) {
    columns.push('visibility');
    values.push(post.visibility ?? 'public');
  }
  if (post.payloadKey) {
    columns.push('payload_key');
    values.push(post.payloadKey);
  }
  if (post.swfKey) {
    columns.push('swf_key');
    values.push(post.swfKey);
  }
  if (post.actorId) {
    columns.push('actor_id');
    values.push(post.actorId);
  }
  await db
    .prepare(`INSERT INTO posts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .bind(...values)
    .run();
}

async function pinFor(userId: string, postId: string): Promise<void> {
  await db.prepare('UPDATE users SET pinned_post_id = ? WHERE id = ?').bind(postId, userId).run();
}

async function seedPoll(postId: string, pollId: string, question: string, optionId: string, label: string) {
  await db
    .prepare('INSERT INTO polls (id, post_id, question, ends_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(pollId, postId, question, '2099-01-01T00:00:00.000Z', NOW)
    .run();
  await db
    .prepare('INSERT INTO poll_options (id, poll_id, label, votes_count) VALUES (?, ?, ?, 0)')
    .bind(optionId, pollId, label)
    .run();
}

function gameIdsOf(body: unknown): string[] {
  const rows = (body as { games: Array<{ id: string; postId: string }> }).games ?? [];
  return rows.map((row) => row.id ?? row.postId).sort();
}

async function rowsFromTable(table: string): Promise<string[]> {
  const rows = await db.prepare(`SELECT DISTINCT post_id FROM ${table} ORDER BY post_id`).all<{ post_id: string }>();
  return rows.results.map((row) => row.post_id);
}

describe('pinned post read path', () => {
  it('never returns a private pinned post to a stranger or anonymous reader', async () => {
    await seedPost({ id: 'pin-private', text: 'PINNED SECRET FOLLOWERS ONLY', visibility: 'private' });
    await pinFor(ALICE.id, 'pin-private');
    const app = appFor(profiles, null);

    const anon = await requestJson(app, '/users/alice/pinned');
    assert.deepEqual(anon.body, { post: null }, 'anonymous response must contain no post object');
    assert.equal(anon.text.includes('PINNED SECRET FOLLOWERS ONLY'), false);

    const stranger = await requestJson(appFor(profiles, BOB), '/users/alice/pinned');
    assert.deepEqual(stranger.body, { post: null });
    assert.equal(stranger.text.includes('PINNED SECRET FOLLOWERS ONLY'), false);

    for (const viewer of [ALICE, CAROL]) {
      const allowed = await requestJson(appFor(profiles, viewer), '/users/alice/pinned');
      assert.equal(allowed.status, 200);
      const post = (allowed.body as { post: { id: string; text: string } }).post;
      assert.deepEqual(
        { id: post.id, text: post.text },
        { id: 'pin-private', text: 'PINNED SECRET FOLLOWERS ONLY' },
        `${viewer.username} is allowed to read the pinned post`,
      );
    }
  });

  it('returns a direct pinned post only to its author and the mentioned user', async () => {
    await seedPost({
      id: 'pin-direct',
      text: 'PINNED SECRET DIRECT MESSAGE',
      visibility: 'direct',
      mentions: [{ username: 'bob', user_id: BOB.id }],
    });
    await pinFor(ALICE.id, 'pin-direct');

    for (const viewer of [null, CAROL]) {
      const denied = await requestJson(appFor(profiles, viewer), '/users/alice/pinned');
      assert.deepEqual(denied.body, { post: null }, `${viewer?.username ?? 'anonymous'} must not see the direct post`);
      assert.equal(denied.text.includes('PINNED SECRET DIRECT MESSAGE'), false);
    }
    for (const viewer of [ALICE, BOB]) {
      const allowed = await requestJson(appFor(profiles, viewer), '/users/alice/pinned');
      const post = (allowed.body as { post: { id: string; text: string } }).post;
      assert.deepEqual(
        { id: post.id, text: post.text },
        { id: 'pin-direct', text: 'PINNED SECRET DIRECT MESSAGE' },
        `${viewer.username} is allowed to read the direct post`,
      );
    }
  });

  it('still returns a public pinned post to everyone', async () => {
    await seedPost({ id: 'pin-public', text: 'publicly pinned' });
    await pinFor(ALICE.id, 'pin-public');
    const anon = await requestJson(appFor(profiles, null), '/users/alice/pinned');
    const post = (anon.body as { post: { id: string; text: string } }).post;
    assert.deepEqual({ id: post.id, text: post.text }, { id: 'pin-public', text: 'publicly pinned' });
  });
});

describe('poll read path', () => {
  it('hides private and direct poll questions and options from unauthorised readers', async () => {
    await seedPost({ id: 'poll-private-post', text: 'private poll post', visibility: 'private' });
    await seedPoll(
      'poll-private-post',
      'poll-private-id',
      'PRIVATE POLL QUESTION',
      'opt-private',
      'PRIVATE POLL OPTION',
    );

    await seedPost({
      id: 'poll-direct-post',
      text: 'direct poll post',
      visibility: 'direct',
      mentions: [{ username: 'bob', user_id: BOB.id }],
    });
    await seedPoll('poll-direct-post', 'poll-direct-id', 'DIRECT POLL QUESTION', 'opt-direct', 'DIRECT POLL OPTION');

    await seedPost({ id: 'poll-public-post', text: 'public poll post' });
    await seedPoll('poll-public-post', 'poll-public-id', 'PUBLIC POLL QUESTION', 'opt-public', 'PUBLIC POLL OPTION');

    const app = appFor(polls, null);

    const anonPrivate = await requestJson(app, '/polls/poll-private-post');
    assert.deepEqual(anonPrivate.body, { error: 'Poll not found' });
    assert.equal(anonPrivate.text.includes('PRIVATE POLL QUESTION'), false);
    assert.equal(anonPrivate.text.includes('PRIVATE POLL OPTION'), false);

    const strangerPrivate = await requestJson(app, '/polls/poll-private-post', { headers: cookieFor(BOB) });
    assert.deepEqual(strangerPrivate.body, { error: 'Poll not found' });
    assert.equal(strangerPrivate.text.includes('PRIVATE POLL QUESTION'), false);

    for (const viewer of [ALICE, CAROL]) {
      const allowed = await requestJson(app, '/polls/poll-private-post', { headers: cookieFor(viewer) });
      assert.equal(allowed.status, 200);
      const poll = allowed.body as { poll: { question: string }; options: Array<{ label: string }> };
      assert.equal(poll.poll.question, 'PRIVATE POLL QUESTION');
      assert.deepEqual(
        poll.options.map((option) => option.label),
        ['PRIVATE POLL OPTION'],
      );
    }

    const anonDirect = await requestJson(app, '/polls/poll-direct-post');
    assert.deepEqual(anonDirect.body, { error: 'Poll not found' });
    const unmentioned = await requestJson(app, '/polls/poll-direct-post', { headers: cookieFor(CAROL) });
    assert.deepEqual(unmentioned.body, { error: 'Poll not found' });
    assert.equal(unmentioned.text.includes('DIRECT POLL QUESTION'), false);
    const mentioned = await requestJson(app, '/polls/poll-direct-post', { headers: cookieFor(BOB) });
    const directPoll = mentioned.body as { poll: { question: string }; options: Array<{ label: string }> };
    assert.equal(directPoll.poll.question, 'DIRECT POLL QUESTION');
    assert.deepEqual(
      directPoll.options.map((option) => option.label),
      ['DIRECT POLL OPTION'],
    );

    const publicPoll = await requestJson(app, '/polls/poll-public-post');
    const anonPublic = publicPoll.body as { poll: { question: string }; options: Array<{ label: string }> };
    assert.equal(anonPublic.poll.question, 'PUBLIC POLL QUESTION');
    assert.deepEqual(
      anonPublic.options.map((option) => option.label),
      ['PUBLIC POLL OPTION'],
    );
  });
});

describe('game listing read paths', () => {
  async function seedGames() {
    await seedPost({ id: 'game-public', text: 'public game', payloadKey: 'games/public.zip' });
    await seedPost({
      id: 'game-unlisted',
      text: 'unlisted game',
      visibility: 'unlisted',
      payloadKey: 'games/unlisted.zip',
    });
    await seedPost({
      id: 'game-private',
      text: 'PRIVATE GAME SECRET',
      visibility: 'private',
      payloadKey: 'games/private.zip',
    });
    await seedPost({
      id: 'game-direct',
      text: 'DIRECT GAME SECRET',
      visibility: 'direct',
      payloadKey: 'games/direct.zip',
      mentions: [{ username: 'bob', user_id: BOB.id }],
    });
  }

  it('filters private and direct games from recent, trending and cursor listings', async () => {
    await seedGames();
    for (const path of ['/games?limit=20', '/games?trending=true&limit=20', `/games?cursor=${AFTER}&limit=20`]) {
      const anon = await requestJson(appFor(games, null), path);
      assert.equal(anon.status, 200, `${path}: ${anon.text}`);
      assert.deepEqual(gameIdsOf(anon.body), ['game-public', 'game-unlisted'], path);
      assert.equal(anon.text.includes('PRIVATE GAME SECRET'), false, path);

      const stranger = await requestJson(appFor(games, BOB), path);
      assert.deepEqual(gameIdsOf(stranger.body), ['game-direct', 'game-public', 'game-unlisted'], path);
      assert.equal(stranger.text.includes('PRIVATE GAME SECRET'), false, path);

      const follower = await requestJson(appFor(games, CAROL), path);
      assert.deepEqual(gameIdsOf(follower.body), ['game-private', 'game-public', 'game-unlisted'], path);
      assert.equal(follower.text.includes('DIRECT GAME SECRET'), false, path);

      const author = await requestJson(appFor(games, ALICE), path);
      assert.deepEqual(gameIdsOf(author.body), ['game-direct', 'game-private', 'game-public', 'game-unlisted'], path);
    }
  });

  it('filters private and direct games from shuffle listings', async () => {
    await seedGames();
    const anon = await requestJson(appFor(games, null), '/games?shuffle=true&limit=20');
    assert.equal(anon.status, 200, anon.text);
    assert.deepEqual(gameIdsOf(anon.body), ['game-public', 'game-unlisted']);

    const stranger = await requestJson(appFor(games, BOB), '/games?shuffle=true&limit=20');
    assert.deepEqual(gameIdsOf(stranger.body), ['game-direct', 'game-public', 'game-unlisted']);
    assert.equal(stranger.text.includes('PRIVATE GAME SECRET'), false);

    const follower = await requestJson(appFor(games, CAROL), '/games?shuffle=true&limit=20');
    assert.deepEqual(gameIdsOf(follower.body), ['game-private', 'game-public', 'game-unlisted']);
    assert.equal(follower.text.includes('DIRECT GAME SECRET'), false);
  });

  it('filters recommended candidates and the initialId override by viewer', async () => {
    await seedGames();
    const stranger = await requestJson(appFor(games, BOB), '/games?recommended=true&limit=20&initialId=game-private');
    assert.equal(stranger.status, 200, stranger.text);
    assert.deepEqual(gameIdsOf(stranger.body), ['game-direct', 'game-public', 'game-unlisted']);
    assert.equal(stranger.text.includes('PRIVATE GAME SECRET'), false);

    const author = await requestJson(appFor(games, ALICE), '/games?recommended=true&limit=20');
    assert.deepEqual(gameIdsOf(author.body), ['game-direct', 'game-private', 'game-public', 'game-unlisted']);
  });

  it('ignores unreadable games when recording arcade events and dwell time', async () => {
    await seedGames();
    const app = appFor(games, BOB);
    const events = await requestJson(app, '/games/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        events: [
          { postId: 'game-private', eventType: 'view', dwellMs: 3000, gameType: 'zip' },
          { postId: 'game-public', eventType: 'view', dwellMs: 3000, gameType: 'zip' },
        ],
      }),
    });
    assert.equal(events.status, 200, events.text);
    assert.deepEqual(await rowsFromTable('arcade_events'), ['game-public']);

    const dwell = await requestJson(app, '/games/dwell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plays: [
          { postId: 'game-private', dwellMs: 3000, gameType: 'zip' },
          { postId: 'game-public', dwellMs: 3000, gameType: 'zip' },
        ],
      }),
    });
    assert.equal(dwell.status, 200, dwell.text);
    assert.deepEqual(await rowsFromTable('user_game_plays'), ['game-public']);
  });
});

describe('current topic read path', () => {
  it('does not serve private or direct games as the current topic', async () => {
    await seedPost({
      id: 'topic-private',
      text: 'PRIVATE TOPIC SECRET',
      visibility: 'private',
      payloadKey: 'games/private-topic.zip',
    });
    for (const viewer of [null, ALICE]) {
      const response = await requestJson(appFor(currentTopic, viewer), '/current-topic');
      assert.deepEqual(response.body, { error: 'No Flash/HTML posts found' });
      assert.equal(response.text.includes('PRIVATE TOPIC SECRET'), false);
    }

    await db.prepare('DELETE FROM posts').run();
    await seedPost({
      id: 'topic-direct',
      text: 'DIRECT TOPIC SECRET',
      visibility: 'direct',
      mentions: [{ username: 'bob', user_id: BOB.id }],
      payloadKey: 'games/direct-topic.zip',
    });
    const direct = await requestJson(appFor(currentTopic, null), '/current-topic');
    assert.deepEqual(direct.body, { error: 'No Flash/HTML posts found' });
    assert.equal(direct.text.includes('DIRECT TOPIC SECRET'), false);
  });

  it('still serves a public game and a public remote game', async () => {
    await seedPost({ id: 'topic-public', text: 'public topic', payloadKey: 'games/public-topic.zip' });
    const publicTopic = await requestJson(appFor(currentTopic, null), '/current-topic');
    const publicBody = publicTopic.body as { id: string; text: string };
    assert.deepEqual({ id: publicBody.id, text: publicBody.text }, { id: 'topic-public', text: 'public topic' });

    await db.prepare('DELETE FROM posts').run();
    await seedPost({
      id: 'topic-remote',
      text: 'remote topic',
      actorId: 'https://remote.example/users/remote',
      payloadKey: 'games/remote-topic.zip',
    });
    const remote = await requestJson(appFor(currentTopic, null), '/current-topic');
    const remoteBody = remote.body as { id: string; text: string };
    assert.deepEqual({ id: remoteBody.id, text: remoteBody.text }, { id: 'topic-remote', text: 'remote topic' });
  });
});

describe('tag aggregate read paths', () => {
  it('excludes private and direct hashtags from trending and suggestions', async () => {
    await seedPost({ id: 'tag-public', text: 'one #visibletag', hashtags: ['visibletag'] });
    await seedPost({
      id: 'tag-private',
      text: 'two #hiddentag',
      hashtags: ['hiddentag'],
      visibility: 'private',
    });
    await seedPost({
      id: 'tag-direct',
      text: 'three #hiddentag',
      hashtags: ['hiddentag'],
      visibility: 'direct',
      mentions: [{ username: 'bob', user_id: BOB.id }],
    });
    const app = appFor(tags, null);

    const trending = await requestJson(app, '/tags/trending?recent_count=100');
    assert.equal(trending.status, 200, trending.text);
    const trendingTags = (trending.body as { tags: Array<{ tag: string; count: number }> }).tags;
    assert.deepEqual(
      trendingTags.map((tag) => tag.tag),
      ['visibletag'],
    );
    assert.deepEqual(
      trendingTags.map((tag) => tag.count),
      [1],
    );
    assert.equal(trending.text.includes('hiddentag'), false);

    const hidden = await requestJson(app, '/tags/suggest?q=hiddent');
    assert.deepEqual(hidden.body, { tags: [] });

    const visible = await requestJson(app, '/tags/suggest?q=visible');
    assert.deepEqual(visible.body, { tags: [{ tag: 'visibletag', count: 1 }] });
  });

  it('keeps public remote posts eligible in tag aggregates', async () => {
    await seedPost({
      id: 'tag-remote',
      text: 'remote #remotetag',
      hashtags: ['remotetag'],
      actorId: 'https://remote.example/users/remote',
    });
    const app = appFor(tags, null);
    const suggest = await requestJson(app, '/tags/suggest?q=remotet');
    assert.deepEqual(suggest.body, { tags: [{ tag: 'remotetag', count: 1 }] });
    const trending = await requestJson(app, '/tags/trending?recent_count=100');
    const trendingTags = (trending.body as { tags: Array<{ tag: string }> }).tags;
    assert.deepEqual(
      trendingTags.map((tag) => tag.tag),
      ['remotetag'],
    );
  });

  it('counts a public post and hides a private duplicate of the same hashtag', async () => {
    await seedPost({ id: 'dup-public', text: 'public #sharedtag', hashtags: ['sharedtag'] });
    await seedPost({
      id: 'dup-private',
      text: 'private #sharedtag',
      hashtags: ['sharedtag'],
      visibility: 'private',
    });
    const suggest = await requestJson(appFor(tags, null), '/tags/suggest?q=shared');
    assert.deepEqual(suggest.body, { tags: [{ tag: 'sharedtag', count: 1 }] });
  });
});

describe('per viewer access to tag aggregates is intentionally public', () => {
  it('does not leak private hashtags even when the viewer is the author', async () => {
    await seedPost({
      id: 'tag-author-private',
      text: 'author #authortag',
      hashtags: ['authortag'],
      visibility: 'private',
    });
    const suggest = await requestJson(appFor(tags, ALICE), '/tags/suggest?q=author');
    assert.deepEqual(suggest.body, { tags: [] });
  });
});
