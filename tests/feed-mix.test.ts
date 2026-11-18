import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { feedAuthorKey, feedOrigin, mixFeedOrigins } from '../functions/lib/feed-mix.ts';
import { loadRecommendationSourceRows } from '../functions/lib/recommendation-sources.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

interface Item {
  post: Record<string, unknown>;
  score: number;
}

function local(id: string, userId = `user-${id}`, score = 1): Item {
  return { post: { id, user_id: userId, username: userId }, score };
}

function remote(id: string, actorId = `https://remote.example/users/${id}`, score = 1): Item {
  return { post: { id, user_id: '', actor_id: actorId, username: `remote-${id}` }, score };
}

const getPost = (item: Item): Record<string, unknown> => item.post;

describe('feed origin mixing', () => {
  it('classifies remote posts by actor_id and user_id', () => {
    assert.equal(feedOrigin({ user_id: '' }), 'external');
    assert.equal(feedOrigin({ user_id: '', actor_id: 'https://remote.example/users/a' }), 'external');
    assert.equal(feedOrigin({ user_id: 'local-1' }), 'local');
    assert.equal(
      feedOrigin({ user_id: 'https://remote.example/users/a', actor_id: 'https://remote.example/users/a' }),
      'external',
    );

    assert.equal(
      feedAuthorKey({ user_id: '', actor_id: 'https://remote.example/users/a' }),
      'actor:https://remote.example/users/a',
    );
    assert.equal(feedAuthorKey({ user_id: 'local-1' }), 'user:local-1');
    assert.equal(feedAuthorKey({ user_id: '', username: 'bob@remote.example' }), 'remote:bob@remote.example');
  });

  it('alternates external and local while preserving the order of each side', () => {
    const ranked = [
      local('l1', 'user-a', 10),
      local('l2', 'user-b', 9),
      remote('r1', 'https://remote.example/users/a', 8),
      local('l3', 'user-c', 7),
      remote('r2', 'https://remote.example/users/b', 6),
      remote('r3', 'https://remote.example/users/c', 5),
    ];

    const result = mixFeedOrigins(ranked, getPost, 6);
    assert.deepEqual(
      result.items.map((item) => item.post.id),
      ['l1', 'r1', 'l2', 'r2', 'l3', 'r3'],
    );
    assert.equal(result.nextOrigin, 'local');
  });

  it('fills the rest from one side when the other runs out', () => {
    const ranked = [
      local('l1', 'user-a', 5),
      local('l2', 'user-b', 4),
      remote('r1', 'https://remote.example/users/a', 3),
    ];
    const result = mixFeedOrigins(ranked, getPost, 3);
    assert.deepEqual(
      result.items.map((item) => item.post.id),
      ['l1', 'r1', 'l2'],
    );
  });

  it('caps each remote actor separately instead of treating all remote posts as one author', () => {
    const ranked = [
      remote('r1', 'https://remote.example/users/a'),
      remote('r2', 'https://remote.example/users/a'),
      remote('r3', 'https://remote.example/users/a'),
      remote('r4', 'https://remote.example/users/b'),
      local('l1', 'user-1'),
      local('l2', 'user-2'),
      local('l3', 'user-3'),
    ];

    const result = mixFeedOrigins(ranked, getPost, 6, { maxPerAuthor: 2 });
    const ids = result.items.map((item) => item.post.id);
    assert.deepEqual(ids, ['l1', 'r1', 'l2', 'r2', 'l3', 'r4']);
  });

  it('starts from the cursor origin so the pattern survives a page boundary', () => {
    const ranked = [local('l1', 'user-a'), remote('r1', 'https://remote.example/users/a'), local('l2', 'user-b')];
    const result = mixFeedOrigins(ranked, getPost, 2, { first: 'external' });
    assert.deepEqual(
      result.items.map((item) => item.post.id),
      ['r1', 'l1'],
    );
    assert.equal(result.nextOrigin, 'external');
  });

  it('returns an empty page safely', () => {
    assert.deepEqual(mixFeedOrigins([], getPost, 10), { items: [], nextOrigin: 'local' });
    assert.deepEqual(mixFeedOrigins([local('l1')], getPost, 0), { items: [], nextOrigin: 'local' });
  });
});

describe('recommendation source rows', () => {
  let db: TestDatabase;

  before(async () => {
    db = createTestDatabase();
    // Some migrations seed sample posts; start from an empty timeline.
    await db.prepare('DELETE FROM posts').run();
    await seedLocalUser(db, { id: 'local-author', username: 'alice', displayName: 'Alice' });
    const insert = db.prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, status, actor_id, ap_object_id, created_at)
       VALUES (?, ?, ?, ?, '[]', 'published', ?, ?, ?)`,
    );
    const now = Date.now();
    for (let index = 0; index < 3; index++) {
      const localId = `local-${index}`;
      await insert
        .bind(
          localId,
          'local-author',
          'alice',
          `local post ${index}`,
          null,
          null,
          new Date(now - index * 60_000).toISOString(),
        )
        .run();
      const remoteId = `remote-${index}`;
      await insert
        .bind(
          remoteId,
          '',
          'bob@remote.example',
          `remote post ${index}`,
          `https://remote.example/users/bob`,
          `https://remote.example/notes/${index}`,
          new Date(now - index * 60_000 - 30_000).toISOString(),
        )
        .run();
    }
  });

  after(() => db.close());

  it('loads enough candidates of both origins for a 1:1 mix', async () => {
    const sources = await loadRecommendationSourceRows(db as unknown as D1Database, null, 10, Date.now());
    assert.equal(sources.recentLocal.length, 3);
    assert.equal(sources.recentExternal.length, 3);
    assert.equal(sources.trendingLocal.length, 3);
    assert.equal(sources.trendingExternal.length, 3);

    const mixed = mixFeedOrigins([...sources.recentLocal, ...sources.recentExternal], (post) => post, 6);
    const origins = mixed.items.map((post) => feedOrigin(post));
    assert.deepEqual(origins, ['local', 'external', 'local', 'external', 'local', 'external']);
  });
});
