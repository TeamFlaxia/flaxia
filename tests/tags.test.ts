import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

describe('GET /api/tags/trending', () => {
  beforeEach(resetDb);

  it('returns top 5 tags → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/tags/trending`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.tags));
    for (const tag of data.tags) {
      assert.equal(typeof tag.percentage, 'number');
    }
  });

  it('reports each tag as a share of the recent post sample', async () => {
    const { cookie } = await seedUserAndLogin('pct');
    for (const text of ['one #pcttag', 'two #pcttag', 'three']) {
      const created = await fetch(`${BASE_URL}/api/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ text }),
      });
      assert.equal(created.status, 201);
    }

    const first = (await (await fetch(`${BASE_URL}/api/tags/trending`)).json()) as {
      tags: Array<{ tag: string; count: number; percentage: number }>;
    };
    const firstTag = first.tags.find((tag) => tag.tag === 'pcttag');
    assert.ok(firstTag, 'expected #pcttag in the trending list');
    assert.equal(firstTag.count, 2);
    assert.equal(firstTag.percentage, 66.7);

    // A repeated hashtag inside one post is one post, not two.
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'four #pcttag #pcttag' }),
    });
    const second = (await (await fetch(`${BASE_URL}/api/tags/trending`)).json()) as {
      tags: Array<{ tag: string; count: number; percentage: number }>;
    };
    const secondTag = second.tags.find((tag) => tag.tag === 'pcttag');
    assert.ok(secondTag);
    assert.equal(secondTag.count, 3);
    assert.equal(secondTag.percentage, 75);
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
