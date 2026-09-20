import assert from 'node:assert';
import { describe, it } from 'node:test';
import { BASE_URL, resetDb } from './helpers/setup.ts';

// Crowd integration tests.
//
// The Crowd feature has two surfaces, split across two Pages Functions:
//   1. POST /api/crowd/webhook (functions/api/crowd/webhook.ts, backed by
//      functions/lib/crowd.ts) — callbacks from the crowd orchestrator
//      (nsfw / vector-embed workloads) that write to D1.
//   2. GET /api/crowd/* (functions/api/crowd/[[route]].ts) — immutable asset
//      proxy for the @flaxia/node bundle.
//
// These tests run against the same dev server (port 8788) as the other suites.
// Since the local dev server keeps app data on the primary DB binding (the
// /api/test/reset helper clears a separate test binding), each test uses a
// unique user so runs stay isolated from previous runs.

const RUN = String(Date.now());
let seq = 0;

async function loginUnique(): Promise<string> {
  const s = `ct${RUN}_${++seq}`;
  const email = `${s}@test.com`;
  await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', username: s, display_name: `Crowd ${s}` }),
  });
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.ok(cookie, 'expected a session cookie after login');
  return cookie;
}

async function createTextPost(cookie: string, text = 'crowd test post'): Promise<string> {
  const prep = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'post.txt' }),
  });
  const prepData = (await prep.json()) as { postId?: string };
  assert.ok(prepData.postId, 'prepare should return postId');
  const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ postId: prepData.postId, text }),
  });
  assert.equal(commit.status, 200, 'commit should publish the post');
  return prepData.postId as string;
}

async function sendWebhook(
  type: string,
  body: Record<string, unknown>,
  params: Record<string, string> = {},
): Promise<Response> {
  const query = new URLSearchParams({ type, ...params }).toString();
  return fetch(`${BASE_URL}/api/crowd/webhook?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getPost(cookie: string, postId: string): Promise<{ hashtags: string[] }> {
  const res = await fetch(`${BASE_URL}/api/posts/${postId}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { hashtags?: string };
  const parsed = typeof data.hashtags === 'string' ? JSON.parse(data.hashtags) : (data.hashtags ?? []);
  return { hashtags: Array.isArray(parsed) ? parsed : [] };
}

async function getNsfwScans(postId: string): Promise<Array<Record<string, string>>> {
  const res = await fetch(`${BASE_URL}/api/test/nsfw-scans`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { scans: Array<Record<string, string>> };
  return data.scans.filter((s) => s.post_id === postId);
}

describe('GET /api/crowd/* — asset proxy', () => {
  it('proxies /api/crowd/index.js with JS content type and CORS headers', async () => {
    const res = await fetch(`${BASE_URL}/api/crowd/index.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/javascript/);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://flaxia.app');
    assert.match(res.headers.get('cache-control') ?? '', /max-age=\d+.*immutable/);
  });

  it('serves assets under a versioned path (version segment stripped)', async () => {
    const res = await fetch(`${BASE_URL}/api/crowd/v0.3.1-0/index.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/javascript/);
  });

  it('returns 404 for missing assets but still sets nosniff', async () => {
    const res = await fetch(`${BASE_URL}/api/crowd/crowd-does-not-exist-xyz.js`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('rejects non-GET methods on the proxy', async () => {
    const res = await fetch(`${BASE_URL}/api/crowd/some-asset.js`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/crowd/webhook — protocol', () => {
  it('rejects a payload without taskId → 400', async () => {
    const res = await sendWebhook('vector-embed', { status: 'done', result: {} });
    assert.equal(res.status, 400);
  });

  it('acknowledges failed tasks with {received:true}', async () => {
    const res = await sendWebhook('nsfw', { taskId: 't-fail', status: 'failed', error: 'boom' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
  });

  it('acks done tasks whose callback type is unknown without crashing', async () => {
    const res = await sendWebhook('unknown-workload', { taskId: 't-unknown', status: 'done', result: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
  });

  it('acks invalid JSON bodies gracefully (permanent callback retries)', async () => {
    const res = await fetch(`${BASE_URL}/api/crowd/webhook?type=nsfw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
  });
});

describe('POST /api/crowd/webhook — nsfw', () => {
  it('applies nsfw and element tags from detections to the post', async () => {
    const cookie = await loginUnique();
    const postId = await createTextPost(cookie);

    const res = await sendWebhook(
      'nsfw',
      {
        taskId: 't-nsfw',
        status: 'done',
        result: {
          detections: [{ label: 'FEMALE_GENITALIA_EXPOSED', score: 0.98, box: [0, 0, 10, 10] }],
        },
      },
      { postId },
    );
    assert.equal(res.status, 200);

    const post = await getPost(cookie, postId);
    assert.ok(post.hashtags.includes('nsfw'), 'expected nsfw tag');
    assert.ok(post.hashtags.includes('exposed_genital'), 'expected element tag');
  });

  it('adds partial element tags without the nsfw flag for covered subjects', async () => {
    const cookie = await loginUnique();
    const postId = await createTextPost(cookie);

    await sendWebhook(
      'nsfw',
      {
        taskId: 't-cover',
        status: 'done',
        result: {
          detections: [{ label: 'FEMALE_BREAST_EXPOSED', score: 0.7, box: [0, 0, 10, 10] }],
        },
      },
      { postId },
    );

    const post = await getPost(cookie, postId);
    assert.ok(post.hashtags.includes('exposed_breast'));
    assert.ok(!post.hashtags.includes('nsfw'), 'partial exposure must not flag nsfw');
  });

  it('leaves the post untouched for clean detections', async () => {
    const cookie = await loginUnique();
    const postId = await createTextPost(cookie);

    await sendWebhook(
      'nsfw',
      {
        taskId: 't-clean',
        status: 'done',
        result: {
          detections: [
            { label: 'FEMALE_BREAST_COVERED', score: 0.99, box: [0, 0, 10, 10] },
            { label: 'FEMALE_GENITALIA_EXPOSED', score: 0.1, box: [0, 0, 10, 10] },
          ],
        },
      },
      { postId },
    );

    assert.deepEqual((await getPost(cookie, postId)).hashtags, []);
  });

  it('does not modify posts when the task failed', async () => {
    const cookie = await loginUnique();
    const postId = await createTextPost(cookie);

    await sendWebhook(
      'nsfw',
      {
        taskId: 't-fail',
        status: 'failed',
        error: 'worker crashed',
        result: { detections: [{ label: 'FEMALE_GENITALIA_EXPOSED', score: 0.98, box: [0, 0, 10, 10] }] },
      },
      { postId },
    );

    assert.deepEqual((await getPost(cookie, postId)).hashtags, []);
  });

  it('records the scan as done after a successful detection', async () => {
    const cookie = await loginUnique();
    const postId = await createTextPost(cookie);

    await sendWebhook(
      'nsfw',
      {
        taskId: 't-scan-done',
        status: 'done',
        result: { detections: [{ label: 'MALE_GENITALIA_EXPOSED', score: 0.9, box: [0, 0, 10, 10] }] },
      },
      { postId },
    );

    const scans = await getNsfwScans(postId);
    assert.equal(scans.length, 1, 'expected one scan row');
    assert.equal(scans[0].status, 'done');
    assert.equal(scans[0].scanned_at && scans[0].scanned_at.length > 0, true, 'scanned_at should be set');
  });

  it('does not create a scan row for a task that failed without ever being submitted', async () => {
    const cookie = await loginUnique();
    const postId = await createTextPost(cookie);

    await sendWebhook('nsfw', { taskId: 't-scan-failed', status: 'failed', error: 'boom' }, { postId });

    const scans = await getNsfwScans(postId);
    assert.equal(scans.length, 0, 'failed webhook without prior submit must not create a scan row');
  });

  it('acks nsfw results for a nonexistent post without crashing', async () => {
    const res = await sendWebhook(
      'nsfw',
      {
        taskId: 't-ghost',
        status: 'done',
        result: { detections: [{ label: 'FEMALE_GENITALIA_EXPOSED', score: 0.98, box: [0, 0, 10, 10] }] },
      },
      { postId: 'does-not-exist' },
    );
    assert.equal(res.status, 200);
  });
});

describe('POST /api/crowd/webhook — vector-embed', () => {
  it('persists embeddings so similar-posts finds the peer', async () => {
    const cookie = await loginUnique();
    const postA = await createTextPost(cookie, 'crowd vector A');
    const postB = await createTextPost(cookie, 'crowd vector B');

    for (const postId of [postA, postB]) {
      const res = await sendWebhook(
        'vector-embed',
        {
          taskId: `t-ve-${postId}`,
          status: 'done',
          result: {
            output: {
              vector: [1, 0, 0, 0, 0, 0, 0, 0],
              model: 'Qwen/Qwen3-Embedding-0.6B',
              dimensions: 1024,
            },
          },
        },
        { postId },
      );
      assert.equal(res.status, 200);
    }

    const similar = (await (
      await fetch(`${BASE_URL}/api/posts/${postA}/similar?limit=10`, { headers: { Cookie: cookie } })
    ).json()) as { posts: Array<{ id: string }> };
    const ids = similar.posts.map((p) => p.id);
    assert.ok(ids.includes(postB), `expected ${postB} in similar posts, got ${JSON.stringify(ids)}`);
  });

  it('accepts result objects without the output wrapper', async () => {
    const cookie = await loginUnique();
    const postId = await createTextPost(cookie, 'crowd vector flat');

    const res = await sendWebhook(
      'vector-embed',
      {
        taskId: 't-ve-flat',
        status: 'done',
        result: {
          vector: [1, 1, 0, 0, 0, 0, 0, 0],
          model: 'Qwen/Qwen3-Embedding-0.6B',
          dimensions: 1024,
        },
      },
      { postId },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
  });

  it('acks results without a vector without crashing', async () => {
    const res = await sendWebhook(
      'vector-embed',
      {
        taskId: 't-ve-empty',
        status: 'done',
        result: { output: { model: 'Qwen/Qwen3-Embedding-0.6B' } },
      },
      { postId: 'whatever' },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
  });
});

describe('POST /api/admin/backfill-nsfw', () => {
  it('forbids non-admin users', async () => {
    const cookie = await loginUnique();
    const res = await fetch(`${BASE_URL}/api/admin/backfill-nsfw`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 403);
  });

  it('returns success even with no image candidates', async () => {
    // The admin username is fixed in ADMIN_USERNAMES, so reset users first to
    // avoid collisions with stale rows in the persistent local test DB.
    await resetDb();
    const creds = {
      email: 'admin@test.com',
      password: 'password123',
      username: 'remydrescarlet',
      display_name: 'Admin',
    };
    let res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (res.status !== 201) {
      res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: creds.email, password: creds.password }),
      });
    }
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.ok(cookie, 'expected admin session cookie');

    const backfill = await fetch(`${BASE_URL}/api/admin/backfill-nsfw`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(backfill.status, 200);
    const data = (await backfill.json()) as { success: boolean; submitted: number };
    assert.equal(data.success, true);
    assert.equal(typeof data.submitted, 'number');
  });
});

describe('POST /api/admin/backfill-embeddings', () => {
  it('forbids non-admin users', async () => {
    const cookie = await loginUnique();
    const res = await fetch(`${BASE_URL}/api/admin/backfill-embeddings`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 403);
  });

  it('enqueues text posts that have no embedding', async () => {
    // The admin username is fixed in ADMIN_USERNAMES, so reset users first to
    // avoid collisions with stale rows in the persistent local test DB.
    await resetDb();
    const creds = {
      email: 'admin@test.com',
      password: 'password123',
      username: 'remydrescarlet',
      display_name: 'Admin',
    };
    let res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (res.status !== 201) {
      res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: creds.email, password: creds.password }),
      });
    }
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.ok(cookie, 'expected admin session cookie');

    // A text post has no embedding in the test DB, so it must be picked up.
    await createTextPost(cookie, 'embed me for the recommended feed');

    const backfill = await fetch(`${BASE_URL}/api/admin/backfill-embeddings?drain=false`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(backfill.status, 200);
    const data = (await backfill.json()) as { success: boolean; enqueued: number };
    assert.equal(data.success, true);
    assert.ok(data.enqueued >= 1, `expected at least one post enqueued, got ${data.enqueued}`);
  });
});
