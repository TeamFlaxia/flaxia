import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

// 1x1 transparent PNG — enough for detectMimeType to see the magic bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function seedSubscription(
  username: string,
  data: { planId?: string; status?: string; cancelAtPeriodEnd?: boolean } = {},
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, ...data }),
  });
  assert.ok(res.ok, `seed subscription failed: ${res.status}`);
}

async function uploadStamp(cookie: string, name: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'stamp.png');
  form.append('name', name);
  return fetch(`${BASE_URL}/api/stamps`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
}

async function assertUploadOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  assert.fail(`${context}: expected a successful upload, got ${res.status} ${body}`);
}

async function createPost(cookie: string, text = 'hello badge'): Promise<string> {
  const prep = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'post.txt' }),
  });
  assert.ok(prep.ok, `prepare failed: ${prep.status}`);
  const prepData = (await prep.json()) as { postId?: string };
  assert.ok(prepData.postId, 'prepare should return postId');

  const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ postId: prepData.postId, text }),
  });
  assert.ok(commit.ok, `commit failed: ${commit.status}`);
  return prepData.postId as string;
}

describe('custom stamp entitlement', () => {
  beforeEach(resetDb);

  it('free plan allows 5 stamps and rejects the 6th with 403', async () => {
    const { cookie } = await seedUserAndLogin('1');

    for (let i = 1; i <= 5; i++) {
      const res = await uploadStamp(cookie, `stamp${i}`);
      await assertUploadOk(res, `free stamp ${i}`);
    }

    const sixth = await uploadStamp(cookie, 'stamp6');
    assert.equal(sixth.status, 403);
    const body = (await sixth.json()) as { error: string };
    assert.match(body.error, /Free plan limited to 5/);
  });

  it('active Flaxia+ bypasses the free limit', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'active' });

    for (let i = 1; i <= 6; i++) {
      const res = await uploadStamp(cookie, `stamp${i}`);
      await assertUploadOk(res, `active Flaxia+ stamp ${i}`);
    }
  });

  it('trialing Flaxia+ bypasses the free limit', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'trialing' });

    for (let i = 1; i <= 6; i++) {
      const res = await uploadStamp(cookie, `stamp${i}`);
      await assertUploadOk(res, `trialing stamp ${i}`);
    }
  });

  it('past_due keeps the plan visible but does not bypass the limit', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'past_due' });

    const planRes = await fetch(`${BASE_URL}/api/billing/plan`, { headers: { Cookie: cookie } });
    assert.equal(planRes.status, 200);
    const plan = (await planRes.json()) as { plan: string | null; status: string | null };
    assert.equal(plan.plan, 'flaxia_plus');
    assert.equal(plan.status, 'past_due');

    for (let i = 1; i <= 5; i++) {
      await assertUploadOk(await uploadStamp(cookie, `stamp${i}`), `past_due stamp ${i}`);
    }
    assert.equal((await uploadStamp(cookie, 'stamp6')).status, 403);
  });

  it('canceled subscription does not bypass the limit', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'canceled' });

    for (let i = 1; i <= 5; i++) {
      await assertUploadOk(await uploadStamp(cookie, `stamp${i}`), `canceled stamp ${i}`);
    }
    assert.equal((await uploadStamp(cookie, 'stamp6')).status, 403);
  });

  it('active subscription pending cancellation still bypasses the limit', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, {
      planId: 'flaxia_plus',
      status: 'active',
      cancelAtPeriodEnd: true,
    });

    for (let i = 1; i <= 6; i++) {
      await assertUploadOk(await uploadStamp(cookie, `stamp${i}`), `pending-cancel stamp ${i}`);
    }
  });
});

describe('Flaxia+ badge exposure', () => {
  beforeEach(resetDb);

  it('profile exposes badge_type for active subscribers', async () => {
    const { username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'active' });

    const res = await fetch(`${BASE_URL}/api/users/${username}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user?: { badge_type?: string | null } };
    assert.strictEqual(body.user?.badge_type, 'flaxia_plus');
  });

  it('profile badge_type is null once the subscription is canceled', async () => {
    const { username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'canceled' });

    const res = await fetch(`${BASE_URL}/api/users/${username}`);
    const body = (await res.json()) as { user?: { badge_type?: string | null } };
    assert.strictEqual(body.user?.badge_type, null);
  });

  it('post list rows carry the author badge_type', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'active' });
    await createPost(cookie, 'badged author');

    const res = await fetch(`${BASE_URL}/api/posts?username=${username}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { posts: Array<{ badge_type?: string | null }> };
    assert.ok(body.posts.length > 0, 'expected the created post');
    assert.equal(body.posts[0].badge_type, 'flaxia_plus');
  });

  it('user suggestions carry badge_type', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'active' });

    const res = await fetch(`${BASE_URL}/api/users/suggest?q=${username}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { users: Array<{ username: string; badge_type?: string | null }> };
    const match = body.users.find((u) => u.username === username);
    assert.ok(match, 'expected the user in suggestions');
    assert.equal(match.badge_type, 'flaxia_plus');
  });

  it('SSR profile renders the avatar badge for crawlers', async () => {
    const { username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'active' });

    const res = await fetch(`${BASE_URL}/users/${username}`, {
      headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)', Accept: 'text/html' },
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /ssr-avatar-badge/);
  });
});
