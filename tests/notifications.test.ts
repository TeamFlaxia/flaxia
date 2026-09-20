import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

async function createPost(cookie: string, text: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ postId: crypto.randomUUID(), text }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  return data.post.id as string;
}

async function fetchNotifications(cookie: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE_URL}/api/notifications`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const data = await res.json();
  return data.notifications as Array<Record<string, unknown>>;
}

describe('GET /api/notifications', () => {
  beforeEach(resetDb);

  it('returns notifications list → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/notifications`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.notifications));
  });

  it('returns unread_count', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/notifications`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.unread_count === 'number');
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications`);
    assert.equal(res.status, 401);
  });
});

describe('POST /api/notifications/read-all', () => {
  beforeEach(resetDb);

  it('marks all as read → unread_count becomes 0', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/notifications/read-all`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);

    const notifRes = await fetch(`${BASE_URL}/api/notifications`, {
      headers: { Cookie: cookie },
    });
    const notifData = await notifRes.json();
    assert.equal(notifData.unread_count, 0);
  });

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications/read-all`, {
      method: 'POST',
    });
    assert.equal(res.status, 401);
  });
});

describe('notification de-duplication', () => {
  beforeEach(resetDb);

  it('creates a single notification when a reply also mentions the parent author', async () => {
    const user1 = await seedUserAndLogin('1');
    const user2 = await seedUserAndLogin('2');
    const parentId = await createPost(user2.cookie, 'parent post');

    const replyRes = await fetch(`${BASE_URL}/api/posts/${parentId}/replies/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ replyId: crypto.randomUUID(), text: `@${user2.username} reply body`, hashtags: [] }),
    });
    assert.equal(replyRes.status, 200);

    const notifications = await fetchNotifications(user2.cookie);
    const relevant = notifications.filter((n) => n.type === 'reply' || n.type === 'mention');
    assert.equal(
      relevant.length,
      1,
      `expected 1 notification, got ${relevant.length} (${relevant.map((n) => n.type).join(', ')})`,
    );
  });

  it('creates a single notification when a quote also mentions the quoted author', async () => {
    const user1 = await seedUserAndLogin('1');
    const user2 = await seedUserAndLogin('2');
    const targetId = await createPost(user2.cookie, 'post to quote');

    const quoteRes = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({
        postId: crypto.randomUUID(),
        text: `@${user2.username} quoting this`,
        quotedPostId: targetId,
      }),
    });
    assert.equal(quoteRes.status, 200);

    const notifications = await fetchNotifications(user2.cookie);
    const relevant = notifications.filter((n) => n.type === 'quote' || n.type === 'mention');
    assert.equal(
      relevant.length,
      1,
      `expected 1 notification, got ${relevant.length} (${relevant.map((n) => n.type).join(', ')})`,
    );
  });

  it('collapses case-variant mentions of the same user into one notification', async () => {
    const user1 = await seedUserAndLogin('1');
    const user2 = await seedUserAndLogin('2');

    const upper = `@${user2.username.charAt(0).toUpperCase()}${user2.username.slice(1)}`;
    const postRes = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user1.cookie },
      body: JSON.stringify({ postId: crypto.randomUUID(), text: `${upper} and @${user2.username} hello` }),
    });
    assert.equal(postRes.status, 200);

    const notifications = await fetchNotifications(user2.cookie);
    const mentions = notifications.filter((n) => n.type === 'mention');
    assert.equal(mentions.length, 1, `expected 1 mention, got ${mentions.length}`);
  });
});
