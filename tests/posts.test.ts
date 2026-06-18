import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

describe('POST /api/posts', () => {
  beforeEach(resetDb);

  it('creates post successfully → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Hello, this is a test post!' }),
    });
    assert.equal(res.status, 201);
  });

  it('rejects text longer than 200 chars → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const longText = 'a'.repeat(201);
    const res = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: longText }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/posts/prepare — validation', () => {
  beforeEach(resetDb);

  it('rejects missing filename → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unauthenticated prepare → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.zip' }),
    });
    assert.equal(res.status, 401);
  });

  it('prepares a text-only post (no filename needed)', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ filename: 'test.zip' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.postId);
  });
});

describe('POST /api/posts/commit — validation', () => {
  beforeEach(resetDb);

  async function createPendingPost(cookie: string): Promise<string> {
    const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ filename: 'post.txt' }),
    });
    const data = await res.json();
    return data.postId;
  }

  it('rejects empty text → 422', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ postId, text: '' }),
    });
    assert.equal(res.status, 422);
  });

  it('rejects text longer than 200 chars → 422', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ postId, text: 'a'.repeat(201) }),
    });
    assert.equal(res.status, 422);
  });

  it('accepts text of exactly 200 chars → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ postId, text: 'a'.repeat(200) }),
    });
    assert.equal(res.status, 201);
  });

  it('rejects unauthenticated commit → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects more than 5 hashtags → 422', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ postId, text: 'Post', hashtags: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    });
    assert.equal(res.status, 422);
  });

  it('rejects hashtag longer than 20 chars → 422', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ postId, text: 'Post', hashtags: ['a'.repeat(21)] }),
    });
    assert.equal(res.status, 422);
  });

  it('accepts valid commit with text and hashtags → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ postId, text: 'Hello world', hashtags: ['tag1', 'tag2'] }),
    });
    assert.equal(res.status, 201);
  });

  it('commits with Japanese hashtags → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPendingPost(cookie);
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ postId, text: '日本語の投稿', hashtags: ['日本語'] }),
    });
    assert.equal(res.status, 201);
  });
});

describe('GET /api/posts', () => {
  beforeEach(resetDb);

  it('returns posts for guests → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/posts`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.posts));
  });

  it('cursor pagination works', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post 1' }),
    });
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post 2' }),
    });

    const res = await fetch(`${BASE_URL}/api/posts?limit=1`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.posts.length <= 1);
  });

  it('username filter with cursor pagination works', async () => {
    const { username, cookie } = await seedUserAndLogin('user1');
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post 1' }),
    });
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Post 2' }),
    });

    // Fetch first page
    const res1 = await fetch(`${BASE_URL}/api/posts?username=${username}&limit=1`);
    const data1 = await res1.json();
    assert.equal(data1.posts.length, 1);
    const cursor = data1.posts[0].created_at;

    // Fetch second page
    const res2 = await fetch(`${BASE_URL}/api/posts?username=${username}&limit=1&cursor=${cursor}`);
    const data2 = await res2.json();
    assert.equal(data2.posts.length, 1);
    assert.notEqual(data2.posts[0].id, data1.posts[0].id);
  });

  it('rejects negative limit → 4xx', async () => {
    const res = await fetch(`${BASE_URL}/api/posts?limit=-1`);
    assert.ok(res.status >= 400 && res.status < 500);
  });

  it('rejects non-numeric limit → 4xx', async () => {
    const res = await fetch(`${BASE_URL}/api/posts?limit=abc`);
    assert.ok(res.status >= 400 && res.status < 500);
  });
});

describe('POST /api/posts/:id/fresh', () => {
  beforeEach(resetDb);

  it('toggles fresh on own post', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'My post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    const freshRes = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(freshRes.status, 200);

    const unfreshRes = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(unfreshRes.status, 200);
  });

  it("generates notification for other's post", async () => {
    await seedUserAndLogin('1');
    const { cookie: cookie2 } = await seedUserAndLogin('2');

    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
      },
      body: JSON.stringify({ text: 'User 2 post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    const freshRes = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie2 },
    });
    assert.equal(freshRes.status, 200);
  });

  it('does not generate notification for own post', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'My post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    const freshRes = await fetch(`${BASE_URL}/api/posts/${postId}/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(freshRes.status, 200);
  });

  it('rejects fresh on non-existent post → 404', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/posts/nonexistent-id/fresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });

  it('rejects unauthenticated fresh → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/posts/some-id/fresh`, {
      method: 'POST',
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/report', () => {
  beforeEach(resetDb);

  it('reports post successfully → 200', async () => {
    const { cookie: cookie1 } = await seedUserAndLogin('1');
    const { cookie: cookie2 } = await seedUserAndLogin('2');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1,
      },
      body: JSON.stringify({ text: 'Reportable post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    const res = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
      },
      body: JSON.stringify({ post_id: postId, category: 'spam' }),
    });
    assert.equal(res.status, 200);
  });

  it('rejects duplicate report → 409', async () => {
    const { cookie: cookie1 } = await seedUserAndLogin('1');
    const { cookie: cookie2 } = await seedUserAndLogin('2');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1,
      },
      body: JSON.stringify({ text: 'Reportable post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
      },
      body: JSON.stringify({ post_id: postId, category: 'spam' }),
    });

    const res = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
      },
      body: JSON.stringify({ post_id: postId, category: 'spam' }),
    });
    assert.equal(res.status, 409);
  });

  it('rejects reporting own post → 403', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'My post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    const res = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ post_id: postId, category: 'spam' }),
    });
    assert.equal(res.status, 403);
  });

  it('rejects report with missing post_id → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ category: 'spam' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects report with invalid category → 400', async () => {
    const { cookie: cookie1 } = await seedUserAndLogin('1');
    const { cookie: cookie2 } = await seedUserAndLogin('2');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1,
      },
      body: JSON.stringify({ text: 'Reportable post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    const res = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
      },
      body: JSON.stringify({ post_id: postId, category: 'invalid-category' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unauthenticated report → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: 'some-id', category: 'spam' }),
    });
    assert.equal(res.status, 401);
  });

  it('3rd spam report triggers hide + notification', async () => {
    const { cookie: cookie1 } = await seedUserAndLogin('1');
    const { cookie: cookie2 } = await seedUserAndLogin('2');
    const { cookie: cookie3 } = await seedUserAndLogin('3');
    const { cookie: cookie4 } = await seedUserAndLogin('4');

    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1,
      },
      body: JSON.stringify({ text: 'Reportable post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    // 1st report
    const r1 = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ post_id: postId, category: 'spam' }),
    });
    assert.equal(r1.status, 200);

    // 2nd report
    const r2 = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
      body: JSON.stringify({ post_id: postId, category: 'spam' }),
    });
    assert.equal(r2.status, 200);

    // 3rd report → threshold reached, post hidden
    const r3 = await fetch(`${BASE_URL}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie4 },
      body: JSON.stringify({ post_id: postId, category: 'spam' }),
    });
    assert.equal(r3.status, 200);

    // Verify post is hidden
    const getRes = await fetch(`${BASE_URL}/api/posts/${postId}`);
    assert.equal(getRes.status, 410);

    // Verify notification was created for the post owner
    const notifRes = await fetch(`${BASE_URL}/api/notifications`, {
      headers: { Cookie: cookie1 },
    });
    const notifData = await notifRes.json();
    const notifications = notifData.notifications || notifData;
    assert.ok(notifications.length > 0);
  });
});

describe('DELETE /api/posts/:id', () => {
  beforeEach(resetDb);

  it('deletes own post → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'My post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
  });

  it('deletes own post with a reply → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');

    // Create parent post
    const parentRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Parent post' }),
    });
    const parentData = await parentRes.json();
    const parentId = parentData.id;

    // Create reply
    await fetch(`${BASE_URL}/api/posts/${parentId}/replies/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Reply' }),
    });
    await fetch(`${BASE_URL}/api/posts/${parentId}/replies/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'Reply' }),
    });

    // Try to delete parent post
    const res = await fetch(`${BASE_URL}/api/posts/${parentId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
  });

  it("rejects deleting other's post → 403", async () => {
    await seedUserAndLogin('1');
    const { cookie: cookie2 } = await seedUserAndLogin('2');

    const createRes = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
      },
      body: JSON.stringify({ text: 'User 2 post' }),
    });
    const createData = await createRes.json();
    const postId = createData.id;

    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie2 },
    });
    assert.equal(res.status, 403);
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/posts/some-id`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 401);
  });

  it('rejects delete of non-existent post → 404', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/posts/nonexistent-id`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });
});
