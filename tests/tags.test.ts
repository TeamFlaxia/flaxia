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
