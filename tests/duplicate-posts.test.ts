import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

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

async function timelinePage(params = ''): Promise<{ posts: Array<{ id: string; created_at: string }> }> {
  const response = await fetch(`${BASE_URL}/api/posts${params}`);
  assert.equal(response.status, 200);
  return (await response.json()) as { posts: Array<{ id: string; created_at: string }> };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('exact duplicate posts', () => {
  beforeEach(resetDb);

  it('keeps only the newest copy in the global timeline', async () => {
    const author = await seedUserAndLogin('dupe-global');
    const firstId = await createTextPost(author.cookie, 'Hello duplicate world');
    await sleep(10);
    const secondId = await createTextPost(author.cookie, 'Hello duplicate world');

    const { posts } = await timelinePage('?limit=50');
    const ids = posts.map((post) => post.id);
    assert.ok(ids.includes(secondId), `expected the newest copy, got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(firstId), `expected the older copy to be hidden, got ${JSON.stringify(ids)}`);
  });

  it('keeps identical text from different authors', async () => {
    const firstAuthor = await seedUserAndLogin('dupe-a');
    const secondAuthor = await seedUserAndLogin('dupe-b');
    const firstId = await createTextPost(firstAuthor.cookie, 'Shared phrase');
    const secondId = await createTextPost(secondAuthor.cookie, 'Shared phrase');

    const { posts } = await timelinePage('?limit=50');
    const ids = posts.map((post) => post.id);
    assert.ok(ids.includes(firstId), `expected the first author's post, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(secondId), `expected the second author's post, got ${JSON.stringify(ids)}`);
  });

  it('hides older duplicate replies under the same parent', async () => {
    const author = await seedUserAndLogin('dupe-replies');
    const parentResponse = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: author.cookie },
      body: JSON.stringify({ text: 'Parent for duplicate replies' }),
    });
    assert.equal(parentResponse.status, 201);
    const parent = (await parentResponse.json()) as { id: string };

    const firstReplyId = crypto.randomUUID();
    const secondReplyId = crypto.randomUUID();
    for (const replyId of [firstReplyId, secondReplyId]) {
      const response = await fetch(`${BASE_URL}/api/posts/${parent.id}/replies/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: author.cookie },
        body: JSON.stringify({ replyId, text: 'Same reply text', hashtags: [] }),
      });
      assert.equal(response.status, 200);
      await sleep(10);
    }

    const repliesResponse = await fetch(`${BASE_URL}/api/posts/${parent.id}/replies`);
    assert.equal(repliesResponse.status, 200);
    const data = (await repliesResponse.json()) as { replies: Array<{ id: string }> };
    const ids = data.replies.map((reply) => reply.id);
    assert.ok(ids.includes(secondReplyId), `expected the newest reply, got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(firstReplyId), `expected the older reply to be hidden, got ${JSON.stringify(ids)}`);

    const threadResponse = await fetch(`${BASE_URL}/api/posts/${parent.id}/thread`);
    assert.equal(threadResponse.status, 200);
    const thread = (await threadResponse.json()) as { replies: Array<{ id: string }> };
    const threadIds = thread.replies.map((reply) => reply.id);
    assert.ok(
      !threadIds.includes(firstReplyId),
      `expected the older reply to be hidden in the thread, got ${JSON.stringify(threadIds)}`,
    );
  });

  it('hides an older duplicate that falls on a later page', async () => {
    const author = await seedUserAndLogin('dupe-page');
    const firstId = await createTextPost(author.cookie, 'Repeated across pages');
    await sleep(10);
    const uniqueId = await createTextPost(author.cookie, 'A unique post in between');
    await sleep(10);
    const secondId = await createTextPost(author.cookie, 'Repeated across pages');

    const firstPage = await timelinePage('?limit=1');
    assert.equal(firstPage.posts[0]?.id, secondId);

    const secondPage = await timelinePage(`?limit=1&cursor=${encodeURIComponent(firstPage.posts[0]!.created_at)}`);
    assert.equal(secondPage.posts[0]?.id, uniqueId);

    const thirdPage = await timelinePage(`?limit=1&cursor=${encodeURIComponent(secondPage.posts[0]!.created_at)}`);
    const ids = thirdPage.posts.map((post) => post.id);
    assert.ok(!ids.includes(firstId), `expected the older copy to stay hidden, got ${JSON.stringify(ids)}`);
    assert.equal(thirdPage.posts.length, 0);
  });
});
