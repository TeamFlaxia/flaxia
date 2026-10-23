import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';
import { embedTopic, seedTopicPrototypes } from './helpers/topics.ts';

// The test dev server binds this secret (see package.json dev:test).
const CROWD_WEBHOOK_SECRET = 'test-callback-secret';

async function createTextPost(cookie: string, text: string): Promise<string> {
  const postId = crypto.randomUUID();
  const response = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, text }),
  });
  assert.equal(response.status, 200, 'commit should publish the post');
  return postId;
}

// Simulate the Crowd vector-embed callback that normally arrives seconds after
// a post is published. Tests control the timing: a new post has no embedding
// until this runs.
async function sendVectorEmbed(postId: string, vector: number[]): Promise<void> {
  const query = new URLSearchParams({ type: 'vector-embed', postId });
  query.sort();
  const sig = createHmac('sha256', CROWD_WEBHOOK_SECRET).update(`/api/crowd/webhook?${query}`).digest('hex');
  query.set('sig', sig);
  const response = await fetch(`${BASE_URL}/api/crowd/webhook?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId: `t-${postId}`,
      status: 'done',
      result: { output: { vector, model: 'Qwen/Qwen3-Embedding-0.6B', dimensions: 1024 } },
    }),
  });
  assert.equal(response.status, 200, 'vector-embed callback should be accepted');
}

function unitVector(index: number): number[] {
  const vector = new Array(1024).fill(0);
  vector[index] = 1;
  return vector;
}

async function recommendedIds(cookie: string, limit = 10): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`${BASE_URL}/api/posts/recommended?${params}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as { posts: Array<{ id: string }>; next_cursor: string | null };
    ids.push(...data.posts.map((post) => post.id));
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return ids;
}

describe('GET /api/posts/recommended — freshness', () => {
  beforeEach(resetDb);

  it('surfaces a new post before Crowd has embedded it', async () => {
    const reader = await seedUserAndLogin('rec-reader');
    const oldAuthor = await seedUserAndLogin('rec-old');
    const newAuthor = await seedUserAndLogin('rec-new');

    // Old, embedded posts on one topic establish the reader's interest.
    const oldIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const postId = await createTextPost(oldAuthor.cookie, `old topic zero post ${i}`);
      await sendVectorEmbed(postId, unitVector(0));
      oldIds.push(postId);
    }
    const freshed = await fetch(`${BASE_URL}/api/posts/${oldIds[0]}/fresh`, {
      method: 'POST',
      headers: { Cookie: reader.cookie },
    });
    assert.equal(freshed.status, 200);

    // This post has no row in post_embeddings: Crowd has not processed it yet.
    const newPostId = await createTextPost(newAuthor.cookie, 'brand new post about topic one');

    const ids = await recommendedIds(reader.cookie);
    assert.ok(ids.includes(newPostId), `expected the unembedded post in For You, got ${JSON.stringify(ids)}`);
  });

  it('can recommend lower-ranked posts the reader already freshed', async () => {
    const reader = await seedUserAndLogin('rec-repeat');
    const author = await seedUserAndLogin('rec-source');

    const postIds: string[] = [];
    const texts = [
      'a post about retro platformers',
      'a post about baking sourdough bread',
      'a post about orbital mechanics',
      'a post about watercolor painting',
    ];
    for (const text of texts) {
      const postId = await createTextPost(author.cookie, text);
      await sendVectorEmbed(postId, unitVector(0));
      postIds.push(postId);
    }
    const freshed = await fetch(`${BASE_URL}/api/posts/${postIds[0]}/fresh`, {
      method: 'POST',
      headers: { Cookie: reader.cookie },
    });
    assert.equal(freshed.status, 200);

    const ids = await recommendedIds(reader.cookie, 20);
    assert.ok(ids.includes(postIds[0]!), 'a freshed post can appear again in recommendations');
  });
});

describe('GET /api/posts/recommended — author trust', () => {
  beforeEach(resetDb);

  it('excludes authors who repeatedly post identical content', async () => {
    const reader = await seedUserAndLogin('trust-reader');
    const spammer = await seedUserAndLogin('trust-spammer');
    const author = await seedUserAndLogin('trust-author');

    const spamIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      spamIds.push(await createTextPost(spammer.cookie, 'Buy cheap followers now at spam.example'));
    }
    const legitId = await createTextPost(author.cookie, 'A distinct post about building a game');

    const ids = await recommendedIds(reader.cookie, 20);
    for (const spamId of spamIds) {
      assert.ok(!ids.includes(spamId), `expected repeated post ${spamId} to be filtered out`);
    }
    assert.ok(ids.includes(legitId), `expected the distinct author to remain, got ${JSON.stringify(ids)}`);
  });

  it('keeps authors with only two repeated posts', async () => {
    const reader = await seedUserAndLogin('trust-two-reader');
    const author = await seedUserAndLogin('trust-two-author');

    const firstId = await createTextPost(author.cookie, 'Two repeated posts are tolerated');
    const secondId = await createTextPost(author.cookie, 'Two repeated posts are tolerated!');

    const ids = await recommendedIds(reader.cookie, 20);
    assert.ok(ids.includes(firstId), `expected first post in recommendations, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(secondId), `expected second post in recommendations, got ${JSON.stringify(ids)}`);
  });

  it('hides the older of two exact duplicates', async () => {
    const reader = await seedUserAndLogin('dupe-reader');
    const author = await seedUserAndLogin('dupe-author');

    const firstId = await createTextPost(author.cookie, 'An exactly repeated post');
    const secondId = await createTextPost(author.cookie, 'An exactly repeated post');

    const ids = await recommendedIds(reader.cookie, 20);
    assert.ok(ids.includes(secondId), `expected the newest copy, got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(firstId), `expected the older copy to be hidden, got ${JSON.stringify(ids)}`);
  });
});

describe('GET /api/posts/recommended — pagination', () => {
  beforeEach(resetDb);

  it('does not repeat posts when impressions update between pages', async () => {
    const reader = await seedUserAndLogin('pagination-reader');
    const authors = [];
    for (let index = 0; index < 6; index++) {
      authors.push(await seedUserAndLogin(`pagination-author-${index}`));
    }
    for (const author of authors) {
      for (let index = 0; index < 8; index++) {
        // Keep every post text distinct after normalization. Repeating the
        // same text would lower the author's trust score and empty the feed.
        await createTextPost(author.cookie, `pagination ${crypto.randomUUID().replace(/[0-9-]/g, '')}`);
      }
    }

    const firstParams = new URLSearchParams({ limit: '10' });
    const firstResponse = await fetch(`${BASE_URL}/api/posts/recommended?${firstParams}`, {
      headers: { Cookie: reader.cookie },
    });
    assert.equal(firstResponse.status, 200);
    const firstPage = (await firstResponse.json()) as {
      posts: Array<{ id: string }>;
      next_cursor: string | null;
    };
    assert.equal(firstPage.posts.length, 10, 'expected a full first page');
    assert.ok(firstPage.next_cursor, 'expected a cursor for the second page');

    const firstIds = new Set(firstPage.posts.map((post) => post.id));
    const impressions = await fetch(`${BASE_URL}/api/posts/impressions/batch`, {
      method: 'POST',
      headers: { Cookie: reader.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_ids: [...firstIds] }),
    });
    assert.equal(impressions.status, 200, 'recording impressions should succeed');

    const secondParams = new URLSearchParams({ limit: '10', cursor: firstPage.next_cursor! });
    const secondResponse = await fetch(`${BASE_URL}/api/posts/recommended?${secondParams}`, {
      headers: { Cookie: reader.cookie },
    });
    assert.equal(secondResponse.status, 200);
    const secondPage = (await secondResponse.json()) as { posts: Array<{ id: string }> };

    const repeated = secondPage.posts.filter((post) => firstIds.has(post.id));
    assert.deepEqual(repeated, [], 'the second page must not repeat first-page posts');
  });
});

describe('GET /api/posts/recommended — automatic topics', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTopicPrototypes();
  });

  it("prefers the reader's Fresh topic using Crowd embeddings without manual tags", async () => {
    const reader = await seedUserAndLogin('topic-reader');
    const source = await seedUserAndLogin('topic-source');
    const matched = await seedUserAndLogin('topic-matched');
    const other = await seedUserAndLogin('topic-other');
    const seedText = '足場を飛び越えて最後のボスを倒した';
    const seed = await createTextPost(source.cookie, seedText);
    await embedTopic(seed, seedText, 0);
    const response = await fetch(`${BASE_URL}/api/posts/${seed}/fresh`, {
      method: 'POST',
      headers: { Cookie: reader.cookie },
    });
    assert.equal(response.status, 200);
    const matchingText = 'Finally cleared the last boss after jumping across platforms';
    const matchingId = await createTextPost(matched.cookie, matchingText);
    await embedTopic(matchingId, matchingText, 0);
    const unrelatedText = 'The dough rose beautifully overnight';
    const unrelatedId = await createTextPost(other.cookie, unrelatedText);
    await embedTopic(unrelatedId, unrelatedText, 7);
    const feed = await fetch(`${BASE_URL}/api/posts/recommended?limit=20`, { headers: { Cookie: reader.cookie } });
    assert.equal(feed.status, 200);
    const data = (await feed.json()) as { posts: Array<{ id: string; topic_tags: string[] }> };
    const matchIndex = data.posts.findIndex((post) => post.id === matchingId);
    const otherIndex = data.posts.findIndex((post) => post.id === unrelatedId);
    assert.ok(matchIndex >= 0 && otherIndex >= 0);
    assert.ok(matchIndex < otherIndex, 'topic match should outrank equally fresh unrelated content');
    assert.ok(data.posts[matchIndex].topic_tags.includes('ゲーム'));
  });
});
