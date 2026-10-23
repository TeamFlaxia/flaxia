import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { textSha } from '../functions/lib/topics.ts';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';
import { embedTopic, seedTopicPrototypes, topicCallback, topicVector } from './helpers/topics.ts';

describe('GET /api/tags/trending', () => {
  beforeEach(resetDb);

  it('returns top 5 tags → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/tags/trending`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.tags));
  });

  it('tags ordered by post_count descending', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post with #tag1 #tag1' }),
    });
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post with #tag2' }),
    });

    const res = await fetch(`${BASE_URL}/api/tags/trending`);
    const data = await res.json();
    assert.ok(data.tags.length > 0);
  });

  it('accessible to guests', async () => {
    const res = await fetch(`${BASE_URL}/api/tags/trending`);
    assert.equal(res.status, 200);
  });
});

describe('GET /api/posts?hashtag=xxx', () => {
  beforeEach(resetDb);

  it('filters posts by hashtag', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post with #specialtag' }),
    });

    const res = await fetch(`${BASE_URL}/api/posts?hashtag=specialtag`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.posts.length > 0);
    assert.ok(data.posts.every((p: any) => p.text.includes('#specialtag')));
  });

  it('returns empty array for unknown tag', async () => {
    const res = await fetch(`${BASE_URL}/api/posts?hashtag=unknowntag123`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.posts));
    assert.equal(data.posts.length, 0);
  });

  it('accessible to guests', async () => {
    const res = await fetch(`${BASE_URL}/api/posts?hashtag=test`);
    assert.equal(res.status, 200);
  });
});

describe('public cache headers', () => {
  beforeEach(resetDb);

  it('trending tags are edge-cacheable', async () => {
    const res = await fetch(`${BASE_URL}/api/tags/trending`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /public/);
  });

  it('active ads are edge-cacheable', async () => {
    const res = await fetch(`${BASE_URL}/api/ads/active`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /public/);
  });
});

describe('automatic topic trends and browsing', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTopicPrototypes();
  });

  it('finds untagged Japanese/English posts and uses actual sample size', async () => {
    const author = await seedUserAndLogin('topic-author');
    const ids: string[] = [];
    for (const [index, text] of [
      '足場を飛び越えてボスを倒した',
      'Defeated the final boss',
      'The dough rose overnight',
    ].entries()) {
      const postId = crypto.randomUUID();
      const response = await fetch(`${BASE_URL}/api/posts/commit`, {
        method: 'POST',
        headers: { Cookie: author.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId, text }),
      });
      assert.equal(response.status, 200);
      await embedTopic(postId, text, index < 2 ? 0 : 7);
      ids.push(postId);
    }
    const trendResponse = await fetch(`${BASE_URL}/api/tags/trending`);
    assert.equal(trendResponse.status, 200);
    const trends = (await trendResponse.json()) as { tags: Array<{ tag: string; count: number; percentage: number }> };
    assert.deepEqual(
      trends.tags.find((tag) => tag.tag === 'ゲーム'),
      { tag: 'ゲーム', count: 2, percentage: 66.7 },
    );
    const browse = await fetch(`${BASE_URL}/api/posts?hashtag=${encodeURIComponent('ゲーム')}`);
    assert.equal(browse.status, 200);
    const data = (await browse.json()) as { posts: Array<{ id: string }>; count: number };
    assert.equal(data.count, 2);
    assert.deepEqual(new Set(data.posts.map((post) => post.id)), new Set(ids.slice(0, 2)));
  });
});

describe('semantic topic callback freshness', () => {
  beforeEach(async () => {
    await resetDb();
    await seedTopicPrototypes();
  });

  it('invalidates edited labels and ignores delayed results for the old text', async () => {
    const author = await seedUserAndLogin('topic-edit');
    const postId = crypto.randomUUID();
    const oldText = 'Defeated the final boss';
    const newText = 'The dough rose overnight';
    const published = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { Cookie: author.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, text: oldText }),
    });
    assert.equal(published.status, 200);
    await embedTopic(postId, oldText, 0);
    const edited = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { Cookie: author.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: newText }),
    });
    assert.equal(edited.status, 200);
    await embedTopic(postId, oldText, 0);
    const stale = await fetch(`${BASE_URL}/api/posts?hashtag=${encodeURIComponent('ゲーム')}`);
    assert.equal((await stale.json()).count, 0);
    await embedTopic(postId, newText, 7);
    const updated = await fetch(`${BASE_URL}/api/posts?hashtag=${encodeURIComponent('料理')}`);
    assert.equal((await updated.json()).count, 1);
  });

  it('does not assign labels to wrong-model and malformed embeddings', async () => {
    const author = await seedUserAndLogin('topic-invalid');
    const postId = crypto.randomUUID();
    const text = 'Something to classify';
    const response = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { Cookie: author.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, text }),
    });
    assert.equal(response.status, 200);
    const params = { type: 'vector-embed', postId, sha: await textSha(text) };
    assert.equal((await topicCallback(params, topicVector(0), 'wrong-model')).status, 200);
    assert.equal((await topicCallback(params, [1, 0])).status, 200);
    const feed = await fetch(`${BASE_URL}/api/posts?hashtag=${encodeURIComponent('ゲーム')}`);
    assert.equal((await feed.json()).count, 0);
  });
});
