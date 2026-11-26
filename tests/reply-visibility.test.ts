import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import type { PostVisibility } from '../shared/types/post.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// The shared D1 adapter has no `success` flag on `all()`, while the real route
// handlers check it. Add it locally (same pattern as tests/post-visibility.test.ts).
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
// Node needs the same resolver shim used by the other behavioural API tests.
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

function appFor(route: Hono<AppEnv>, viewer: User | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (viewer) c.set('user', viewer);
    await next();
  });
  app.route('/', route);
  return app;
}

async function seedParent(post: {
  id: string;
  text: string;
  visibility: PostVisibility;
  mentions?: unknown[];
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, mentions, status, visibility, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, 'published', ?, ?)`,
    )
    .bind(post.id, ALICE.id, ALICE.username, post.text, JSON.stringify(post.mentions ?? []), post.visibility, NOW)
    .run();
}

type StoredPost = { id: string; text: string; visibility: string; mentions: string; status: string };

async function storedPost(id: string): Promise<StoredPost | null> {
  return db
    .prepare('SELECT id, text, visibility, mentions, status FROM posts WHERE id = ?')
    .bind(id)
    .first<StoredPost>();
}

type ReplyPayload = {
  reply?: { id: string; text: string; visibility?: string; mentions?: string };
  error?: string;
};

async function commitReply(
  viewer: User,
  parentId: string,
  body: { replyId: string; text: string; gifKey?: string },
): Promise<{ status: number; payload: ReplyPayload; raw: string }> {
  const response = await appFor(replies, viewer).request(
    `http://localhost/posts/${parentId}/replies/commit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, hashtags: [] }),
    },
    envFor(db),
  );
  const raw = await response.text();
  return { status: response.status, payload: JSON.parse(raw) as ReplyPayload, raw };
}

async function prepareReply(
  viewer: User,
  parentId: string,
): Promise<{ status: number; payload: { replyId?: string; gifKey?: string; error?: string }; raw: string }> {
  const response = await appFor(replies, viewer).request(
    `http://localhost/posts/${parentId}/replies/prepare`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'clip.gif', contentType: 'image/gif' }),
    },
    envFor(db),
  );
  const raw = await response.text();
  return { status: response.status, payload: JSON.parse(raw) as { replyId?: string; gifKey?: string }, raw };
}

async function listReplies(
  viewer: User | null,
  parentId: string,
): Promise<{ status: number; replies: Array<{ id: string; text: string; visibility?: string }> }> {
  const response = await appFor(replies, viewer).request(`http://localhost/posts/${parentId}/replies`, {}, envFor(db));
  const raw = await response.text();
  if (response.status !== 200) return { status: response.status, replies: [] };
  const data = JSON.parse(raw) as { replies: Array<{ id: string; text: string; visibility?: string }> };
  return { status: response.status, replies: data.replies };
}

async function threadReplies(
  viewer: User | null,
  parentId: string,
): Promise<{ status: number; replies: Array<{ id: string; text: string }> }> {
  const response = await appFor(replies, viewer).request(`http://localhost/posts/${parentId}/thread`, {}, envFor(db));
  const raw = await response.text();
  if (response.status !== 200) return { status: response.status, replies: [] };
  const data = JSON.parse(raw) as { replies: Array<{ id: string; text: string }> };
  return { status: response.status, replies: data.replies };
}

describe('reply visibility inheritance', () => {
  it('stores and returns the parent visibility for every text-only reply', async () => {
    const cases: Array<{ parentId: string; replyId: string; visibility: PostVisibility }> = [
      { parentId: 'parent-public', replyId: 'reply-public', visibility: 'public' },
      { parentId: 'parent-unlisted', replyId: 'reply-unlisted', visibility: 'unlisted' },
      { parentId: 'parent-private', replyId: 'reply-private', visibility: 'private' },
      { parentId: 'parent-direct', replyId: 'reply-direct', visibility: 'direct' },
    ];
    for (const { parentId, replyId, visibility } of cases) {
      await seedParent({
        id: parentId,
        text: `parent ${visibility}`,
        visibility,
        mentions: visibility === 'direct' ? [{ username: BOB.username, user_id: BOB.id }] : [],
      });
      const text = `reply to ${visibility}`;
      const result = await commitReply(ALICE, parentId, { replyId, text });
      assert.equal(result.status, 200, `${parentId}: ${result.raw}`);
      assert.equal(result.payload.reply?.id, replyId);
      assert.equal(result.payload.reply?.text, text);
      assert.equal(
        result.payload.reply?.visibility,
        visibility,
        `${parentId}: the commit response must report the inherited visibility`,
      );
      const row = await storedPost(replyId);
      assert.deepEqual(row && { ...row }, {
        id: replyId,
        text,
        visibility,
        mentions: row?.mentions,
        status: 'published',
      });
    }
  });

  it('inherits visibility on the prepare row and keeps it when the media reply is committed', async () => {
    await seedParent({ id: 'private-media-parent', text: 'private parent', visibility: 'private' });
    const prepared = await prepareReply(ALICE, 'private-media-parent');
    assert.equal(prepared.status, 200, prepared.raw);
    const replyId = prepared.payload.replyId;
    const gifKey = prepared.payload.gifKey;
    assert.ok(replyId && gifKey);

    const pending = await storedPost(replyId);
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.visibility, 'private', 'the prepared row must not fall back to the public default');

    const committed = await commitReply(ALICE, 'private-media-parent', {
      replyId,
      gifKey,
      text: 'private media reply',
    });
    assert.equal(committed.status, 200, committed.raw);
    assert.equal(committed.payload.reply?.id, replyId);
    assert.equal(committed.payload.reply?.visibility, 'private');
    const row = await storedPost(replyId);
    assert.equal(row?.status, 'published');
    assert.equal(row?.text, 'private media reply');
    assert.equal(row?.visibility, 'private');
  });

  it('hides a private reply from strangers while followers and the author read it', async () => {
    await seedParent({ id: 'private-thread', text: 'followers only', visibility: 'private' });
    const replyId = 'private-reply-1';
    const text = 'private thread reply';
    const committed = await commitReply(ALICE, 'private-thread', { replyId, text });
    assert.equal(committed.status, 200, committed.raw);
    assert.equal((await storedPost(replyId))?.visibility, 'private');

    for (const viewer of [null, BOB]) {
      const result = await listReplies(viewer, 'private-thread');
      assert.equal(result.status, 404, 'a stranger cannot even load the private parent thread');
      const thread = await threadReplies(viewer, 'private-thread');
      assert.equal(thread.status, 404);
    }
    for (const viewer of [ALICE, CAROL]) {
      const result = await listReplies(viewer, 'private-thread');
      assert.equal(result.status, 200);
      assert.deepEqual(
        result.replies.map((reply) => [reply.id, reply.text]),
        [[replyId, text]],
      );
      assert.equal(result.replies[0].visibility, 'private');
      const thread = await threadReplies(viewer, 'private-thread');
      assert.equal(thread.status, 200);
      assert.deepEqual(
        thread.replies.map((reply) => [reply.id, reply.text]),
        [[replyId, text]],
      );
    }
  });

  it('carries the direct parent recipients into the reply so only they can read it', async () => {
    await seedParent({
      id: 'direct-thread',
      text: 'for bob only',
      visibility: 'direct',
      mentions: [{ username: BOB.username, user_id: BOB.id }],
    });
    const replyId = 'direct-reply-1';
    const text = 'direct thread reply';
    const committed = await commitReply(ALICE, 'direct-thread', { replyId, text });
    assert.equal(committed.status, 200, committed.raw);
    assert.equal(committed.payload.reply?.visibility, 'direct');

    const row = await storedPost(replyId);
    assert.equal(row?.visibility, 'direct');
    assert.equal(row?.text, text);
    const replyMentions = JSON.parse(row?.mentions ?? '[]') as Array<{ username?: string; user_id?: string }>;
    assert.ok(
      replyMentions.some((mention) => mention.user_id === BOB.id && mention.username === BOB.username),
      `the reply must keep the parent's direct recipients, got ${row?.mentions}`,
    );

    for (const viewer of [null, CAROL]) {
      const result = await listReplies(viewer, 'direct-thread');
      assert.equal(result.status, 404, 'an unmentioned viewer cannot load the direct parent thread');
      const thread = await threadReplies(viewer, 'direct-thread');
      assert.equal(thread.status, 404);
    }
    for (const viewer of [ALICE, BOB]) {
      const result = await listReplies(viewer, 'direct-thread');
      assert.equal(result.status, 200, `authorized viewer ${viewer?.id ?? 'anonymous'} must see the reply`);
      assert.deepEqual(
        result.replies.map((reply) => [reply.id, reply.text]),
        [[replyId, text]],
      );
      assert.equal(result.replies[0].visibility, 'direct');
      const thread = await threadReplies(viewer, 'direct-thread');
      assert.equal(thread.status, 200);
      assert.deepEqual(
        thread.replies.map((reply) => [reply.id, reply.text]),
        [[replyId, text]],
      );
    }
  });

  it('keeps mentions written in the reply text alongside inherited direct recipients', async () => {
    await seedParent({
      id: 'direct-with-text-mention',
      text: 'for bob only',
      visibility: 'direct',
      mentions: [{ username: BOB.username, user_id: BOB.id }],
    });
    const committed = await commitReply(ALICE, 'direct-with-text-mention', {
      replyId: 'direct-mention-reply',
      text: 'hi @carol',
    });
    assert.equal(committed.status, 200, committed.raw);
    const row = await storedPost('direct-mention-reply');
    assert.equal(row?.visibility, 'direct');
    const userIds = (JSON.parse(row?.mentions ?? '[]') as Array<{ user_id?: string }>)
      .map((mention) => mention.user_id)
      .filter(Boolean);
    assert.deepEqual(userIds.sort(), [BOB.id, CAROL.id].sort());
  });
});
