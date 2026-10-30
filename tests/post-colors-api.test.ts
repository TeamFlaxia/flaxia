import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

async function seedSubscription(
  username: string,
  data: { planId?: string; status?: string; cancelAtPeriodEnd?: boolean } = {},
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, planId: 'flaxia_plus', status: 'active', ...data }),
  });
  assert.ok(res.ok, `seed subscription failed: ${res.status}`);
}

async function preparePost(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'post.txt' }),
  });
  assert.ok(res.ok, `prepare failed: ${res.status}`);
  const data = (await res.json()) as { postId?: string };
  assert.ok(data.postId, 'prepare should return postId');
  return data.postId;
}

async function commitPost(cookie: string, text: string, extra: Record<string, unknown> = {}): Promise<Response> {
  const postId = await preparePost(cookie);
  return fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ postId, text, ...extra }),
  });
}

async function createPost(cookie: string, text: string): Promise<string> {
  const postId = await preparePost(cookie);
  const res = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ postId, text }),
  });
  assert.ok(res.ok, `create post failed: ${res.status}`);
  return postId;
}

async function assertColorRejected(res: Response): Promise<void> {
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'flaxia_plus_required');
}

describe('post text colors API entitlement', () => {
  beforeEach(resetDb);

  it('rejects style markers from free users on create', async () => {
    const { cookie } = await seedUserAndLogin('1');
    for (const text of ['{red}hello{/red}', '{mikan}蜜柑{/mikan}', '{Dinnerborn}flip{/Dinnerborn}']) {
      await assertColorRejected(await commitPost(cookie, text));
    }
  });

  it('rejects color markers from free users on the legacy create route', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: '{red}hello{/red}' }),
    });
    await assertColorRejected(res);
  });

  it('allows markers that are malformed or escaped for free users', async () => {
    const { cookie } = await seedUserAndLogin('1');
    for (const text of ['{red}unclosed', '\\{red}literal{/red}', '`{red}code{/red}`']) {
      const res = await commitPost(cookie, text);
      assert.equal(res.status, 200, `${text} should be accepted`);
    }
  });

  it('accepts style markers from Flaxia+ users and stores them raw', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username);

    const raw =
      '{red}hello{/red} {mikan}蜜柑{/mikan} {kimwaipu}キムワイプ{/kimwaipu} {rainbow}虹{/rainbow} {Dinnerborn}flip{/Dinnerborn}';
    const postId = await createPost(cookie, raw);
    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { post?: { text?: string }; text?: string };
    const text = body.post?.text ?? body.text;
    assert.equal(text, raw);
  });

  it('rejects colors on edit for free users', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPost(cookie, 'plain');

    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: '{red}now colored{/red}' }),
    });
    await assertColorRejected(res);
  });

  it('allows a lapsed subscriber to keep an unchanged colored post', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { status: 'active' });
    const postId = await createPost(cookie, '{red}hello{/red}');

    await seedSubscription(username, { status: 'canceled' });
    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: '{red}hello{/red}' }),
    });
    assert.equal(res.status, 200);
  });

  it('accepts colors in replies and quotes for Flaxia+ users', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username);
    const parentId = await createPost(cookie, 'parent');

    const reply = await fetch(`${BASE_URL}/api/posts/${parentId}/replies/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        replyId: crypto.randomUUID(),
        text: '{red}reply{/red}',
        hashtags: [],
      }),
    });
    assert.equal(reply.status, 200);

    const quote = await commitPost(cookie, '{red}quote{/red}', { quotedPostId: parentId });
    assert.equal(quote.status, 200);
  });

  it('rejects colors in replies for free users', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const parentId = await createPost(cookie, 'parent');

    const res = await fetch(`${BASE_URL}/api/posts/${parentId}/replies/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        replyId: crypto.randomUUID(),
        text: '{red}reply{/red}',
        hashtags: [],
      }),
    });
    await assertColorRejected(res);
  });

  it('rejects colors in quotes for free users', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const quotedId = await createPost(cookie, 'parent');

    const res = await commitPost(cookie, '{red}quote{/red}', { quotedPostId: quotedId });
    await assertColorRejected(res);
  });
});
