import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

interface SearchResponse {
  posts: Array<{ id: string; text: string; username: string }>;
  users: Array<{ id: string; username: string; display_name: string }>;
  games: Array<{ id: string }>;
  web: Array<{ title: string; url: string }>;
}

async function search(query: string, tab = 'all', cookie?: string): Promise<SearchResponse> {
  const response = await fetch(`${BASE_URL}/api/search/v2?q=${encodeURIComponent(query)}&tab=${tab}&limit=20`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  assert.equal(response.status, 200);
  return (await response.json()) as SearchResponse;
}

describe('GET /api/search/v2', () => {
  beforeEach(resetDb);

  it('finds posts by full text and falls back for short CJK queries', async () => {
    const { cookie, username } = await seedUserAndLogin('search-text');
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const create = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: first, text: '猫が好きです #検索テスト', hashtags: ['検索テスト'] }),
    });
    assert.equal(create.status, 200);
    await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: second, text: '犬と散歩しました', hashtags: [] }),
    });

    const long = await search('好きです', 'posts', cookie);
    assert.deepEqual(
      long.posts.map((post) => post.id),
      [first],
    );

    const short = await search('猫', 'posts', cookie);
    assert.deepEqual(
      short.posts.map((post) => post.id),
      [first],
    );

    const users = await search(username, 'users', cookie);
    assert.ok(users.users.some((user) => user.username === username));
  });

  it('honors hashtag and author filters', async () => {
    const { cookie, username } = await seedUserAndLogin('search-filter');
    const tagged = crypto.randomUUID();
    await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: tagged, text: 'filtered result #needle', hashtags: ['needle'] }),
    });

    const byTag = await search('#needle', 'posts', cookie);
    assert.ok(byTag.posts.some((post) => post.id === tagged));

    const byAuthor = await search(`from:${username} filtered`, 'posts', cookie);
    assert.ok(byAuthor.posts.some((post) => post.id === tagged));

    const otherAuthor = await search('from:someone-else filtered', 'posts', cookie);
    assert.ok(!otherAuthor.posts.some((post) => post.id === tagged));
  });

  it('rejects an empty query', async () => {
    const response = await fetch(`${BASE_URL}/api/search/v2?q=&tab=all`);
    assert.equal(response.status, 400);
  });
});
