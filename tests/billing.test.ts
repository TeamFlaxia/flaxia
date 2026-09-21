import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

// ---------------------------------------------------------------------------
// Helper: create a post via the prepare/commit flow
// ---------------------------------------------------------------------------
async function createPost(cookie: string, text = 'test post'): Promise<string> {
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

// ===========================================================================
// GET /api/billing/plan
// ===========================================================================
describe('GET /api/billing/plan', () => {
  beforeEach(resetDb);

  it('returns null plan for unauthenticated user', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/plan`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plan: string | null };
    assert.equal(body.plan, null);
  });

  it('returns null plan for user with no subscription', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/plan`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plan: string | null };
    assert.equal(body.plan, null);
  });
});

// ===========================================================================
// POST /api/billing/checkout — validation
// ===========================================================================
describe('POST /api/billing/checkout', () => {
  beforeEach(resetDb);

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: 'flaxia_plus' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects missing planId → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('Invalid plan'));
  });

  it('rejects invalid planId → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ planId: 'nonexistent_plan' }),
    });
    assert.equal(res.status, 400);
  });

  it('ignores unknown mode and proceeds (500 without Stripe key)', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ planId: 'flaxia_plus', mode: 'invalid' }),
    });
    // `mode` is no longer part of the request contract; without
    // STRIPE_SECRET_KEY the Stripe call fails with 500 rather than 400.
    assert.notEqual(res.status, 400, 'unknown mode should not be a validation error');
    assert.notEqual(res.status, 401, 'should not be unauthorized');
  });
});

// ===========================================================================
// POST /api/market/checkout — validation
// ===========================================================================
describe('POST /api/market/checkout', () => {
  beforeEach(resetDb);

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: 'x', amount: 100 }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects missing postId → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects amount below minimum (100) → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'x', amount: 50 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects amount above maximum (50000) → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'x', amount: 50001 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing amount → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'some-post' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects nonexistent post → 404', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'nonexistent-id', amount: 500 }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('Post not found'));
  });

  it('rejects self-purchase → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPost(cookie, 'my paid post');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId, amount: 500 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('Cannot purchase your own content'));
  });

  it('allows purchase from another user (validation passes, Stripe call expected to fail)', async () => {
    const seller = await seedUserAndLogin('1');
    const buyer = await seedUserAndLogin('2');
    const postId = await createPost(seller.cookie, 'sellable post');

    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyer.cookie },
      body: JSON.stringify({ postId, amount: 500 }),
    });
    // Without STRIPE_SECRET_KEY the Stripe call will fail, but the validation
    // logic should have passed — the endpoint will return 500 rather than a
    // validation error (400/404).
    assert.notEqual(res.status, 400, 'should not be a validation error');
    assert.notEqual(res.status, 401, 'should not be unauthorized');
    assert.notEqual(res.status, 404, 'should not be not-found');
  });
});

// ===========================================================================
// POST /api/billing/checkout — Flaxia+ only
// ===========================================================================
describe('POST /api/billing/checkout — Flaxia+ only', () => {
  beforeEach(resetDb);

  it('accepts Flaxia+ (Stripe call expected to fail without key)', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ planId: 'flaxia_plus' }),
    });
    assert.notEqual(res.status, 400, 'should not be a validation error');
    assert.notEqual(res.status, 401, 'should not be unauthorized');
  });

  for (const planId of ['flaxia_plus_plus', 'flaxia_sharp']) {
    it(`rejects non-offered plan "${planId}" → 400`, async () => {
      const { cookie } = await seedUserAndLogin('1');
      const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ planId }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.ok(body.error.includes('Invalid plan'));
    });
  }
});

// ===========================================================================
// POST /api/market/checkout — boundary amounts
// ===========================================================================
describe('POST /api/market/checkout — amount boundaries', () => {
  beforeEach(resetDb);

  it('accepts minimum amount (100)', async () => {
    const seller = await seedUserAndLogin('1');
    const buyer = await seedUserAndLogin('2');
    const postId = await createPost(seller.cookie);

    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyer.cookie },
      body: JSON.stringify({ postId, amount: 100 }),
    });
    assert.notEqual(res.status, 400, 'amount 100 should be accepted');
  });

  it('accepts maximum amount (50000)', async () => {
    const seller = await seedUserAndLogin('1');
    const buyer = await seedUserAndLogin('2');
    const postId = await createPost(seller.cookie);

    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyer.cookie },
      body: JSON.stringify({ postId, amount: 50000 }),
    });
    assert.notEqual(res.status, 400, 'amount 50000 should be accepted');
  });

  it('rejects amount 99', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'x', amount: 99 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects amount 50001', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'x', amount: 50001 }),
    });
    assert.equal(res.status, 400);
  });
});

// ===========================================================================
// Billing — subscription state, history and portal
// ===========================================================================
async function seedSubscription(
  username: string,
  data: {
    planId?: string;
    status?: string;
    currentPeriodEnd?: string;
    cancelAtPeriodEnd?: boolean;
  } = {},
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, ...data }),
  });
  assert.ok(res.ok, `seed subscription failed: ${res.status}`);
}

describe('billing subscription state', () => {
  beforeEach(resetDb);

  it('rejects a second checkout while subscribed → 409', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'active' });

    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ planId: 'flaxia_plus' }),
    });
    assert.equal(res.status, 409);
  });

  it('GET /plan returns the active plan and cancellation flag', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, {
      planId: 'flaxia_plus',
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    });

    const res = await fetch(`${BASE_URL}/api/billing/plan`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      plan: string | null;
      status: string | null;
      cancelAtPeriodEnd: boolean;
      expiresAt: string | null;
    };
    assert.equal(body.plan, 'flaxia_plus');
    assert.equal(body.status, 'active');
    assert.equal(body.cancelAtPeriodEnd, true);
    assert.equal(body.expiresAt, '2099-01-01T00:00:00.000Z');
  });

  it('GET /plan ignores canceled subscriptions', async () => {
    const { cookie, username } = await seedUserAndLogin('1');
    await seedSubscription(username, { planId: 'flaxia_plus', status: 'canceled' });

    const res = await fetch(`${BASE_URL}/api/billing/plan`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plan: string | null };
    assert.equal(body.plan, null);
  });

  it('GET /transactions requires auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/transactions`);
    assert.equal(res.status, 401);
  });

  it('GET /transactions returns an empty list initially', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/transactions`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { transactions: unknown[] };
    assert.deepEqual(body.transactions, []);
  });

  it('POST /portal requires auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/portal`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});
