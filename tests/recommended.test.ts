import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

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
    for (let i = 0; i < 4; i++) {
      const postId = await createTextPost(author.cookie, `repeatable topic zero post ${i}`);
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
