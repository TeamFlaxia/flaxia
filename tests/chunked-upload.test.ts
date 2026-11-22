import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

// 1x1 transparent PNG; the chunked path only inspects the header for magic
// bytes and dimensions, so trailing padding is safe and keeps fixtures small.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function paddedPng(totalBytes: number): Uint8Array {
  const png = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
  const bytes = new Uint8Array(Math.max(totalBytes, png.length));
  bytes.set(png);
  return bytes;
}

function split(bytes: Uint8Array, parts: number): Uint8Array[] {
  const size = Math.ceil(bytes.length / parts);
  return Array.from({ length: parts }, (_, index) => bytes.slice(index * size, (index + 1) * size));
}

async function prepareImage(cookie: string, name = 'chunked.png') {
  const response = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ files: [{ filename: name, contentType: 'image/png' }] }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    postId: string;
    uploads: Array<{ key: string; uploadUrl: string; kind: string }>;
  };
}

describe('chunked uploads', () => {
  beforeEach(resetDb);

  it('assembles parts into one attachment and serves it', async () => {
    const { cookie, username } = await seedUserAndLogin('chunked');
    const prepared = await prepareImage(cookie);
    const upload = prepared.uploads[0];
    const bytes = paddedPng(1024 * 1024);
    const parts = split(bytes, 2);
    const uploadId = crypto.randomUUID();

    for (const [index, part] of parts.entries()) {
      const response = await fetch(
        `${BASE_URL}/api/upload/${upload.key}?uploadId=${uploadId}&part=${index + 1}&parts=${parts.length}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png', Cookie: cookie },
          body: part,
        },
      );
      assert.equal(response.status, 200, await response.text());
    }

    const finalize = await fetch(
      `${BASE_URL}/api/upload/${upload.key}?uploadId=${uploadId}&parts=${parts.length}&finalize=1`,
      { method: 'PUT', headers: { Cookie: cookie } },
    );
    assert.equal(finalize.status, 200, await finalize.text());

    const media = await fetch(`${BASE_URL}/api/images/${upload.key}`, { headers: { Cookie: cookie } });
    assert.equal(media.status, 200);
    assert.equal((await media.arrayBuffer()).byteLength, bytes.length);

    const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        postId: prepared.postId,
        text: 'chunked attachment',
        hashtags: [],
        attachments: [{ key: upload.key, kind: upload.kind }],
      }),
    });
    assert.equal(commit.status, 200, await commit.text());

    const timeline = await fetch(`${BASE_URL}/api/posts?username=${username}`);
    const data = (await timeline.json()) as { posts: Array<{ id: string; attachments: Array<{ r2_key: string }> }> };
    const post = data.posts.find((entry) => entry.id === prepared.postId);
    assert.ok(post, 'expected the committed post');
    assert.equal(post.attachments[0].r2_key, upload.key);
  });

  it('accepts the same chunked upload for Flaxia+ subscribers', async () => {
    const { cookie, username } = await seedUserAndLogin('chunked-plus-limit');
    const seeded = await fetch(`${BASE_URL}/api/test/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, planId: 'flaxia_plus', status: 'active' }),
    });
    assert.equal(seeded.status, 200, await seeded.text());

    const prepared = await prepareImage(cookie);
    const upload = prepared.uploads[0];
    const uploadId = crypto.randomUUID();
    const bytes = paddedPng(26 * 1024 * 1024);
    const parts = split(bytes, 2);

    for (const [index, part] of parts.entries()) {
      const response = await fetch(
        `${BASE_URL}/api/upload/${upload.key}?uploadId=${uploadId}&part=${index + 1}&parts=${parts.length}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png', Cookie: cookie },
          body: part,
        },
      );
      assert.equal(response.status, 200, await response.text());
    }

    const finalize = await fetch(
      `${BASE_URL}/api/upload/${upload.key}?uploadId=${uploadId}&parts=${parts.length}&finalize=1`,
      { method: 'PUT', headers: { Cookie: cookie } },
    );
    assert.equal(finalize.status, 200, await finalize.text());
  });

  it('rejects a chunked upload above the free 25MB ceiling', async () => {
    const { cookie } = await seedUserAndLogin('chunked-free-limit');
    const prepared = await prepareImage(cookie);
    const upload = prepared.uploads[0];
    const uploadId = crypto.randomUUID();
    // 13MB + 13MB = 26MB, one MB over the free ceiling.
    const bytes = paddedPng(26 * 1024 * 1024);
    const parts = split(bytes, 2);

    for (const [index, part] of parts.entries()) {
      const response = await fetch(
        `${BASE_URL}/api/upload/${upload.key}?uploadId=${uploadId}&part=${index + 1}&parts=${parts.length}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png', Cookie: cookie },
          body: part,
        },
      );
      assert.equal(response.status, 200, await response.text());
    }

    const finalize = await fetch(
      `${BASE_URL}/api/upload/${upload.key}?uploadId=${uploadId}&parts=${parts.length}&finalize=1`,
      { method: 'PUT', headers: { Cookie: cookie } },
    );
    assert.equal(finalize.status, 413);
    const body = (await finalize.json()) as { error?: string };
    assert.match(body.error ?? '', /25MB/);
  });

  it('rejects finalization when a part is missing', async () => {
    const { cookie } = await seedUserAndLogin('chunked-missing');
    const prepared = await prepareImage(cookie);
    const upload = prepared.uploads[0];
    const uploadId = crypto.randomUUID();
    const part = paddedPng(2048);

    const first = await fetch(`${BASE_URL}/api/upload/${upload.key}?uploadId=${uploadId}&part=1&parts=2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', Cookie: cookie },
      body: part,
    });
    assert.equal(first.status, 200, await first.text());

    const finalize = await fetch(`${BASE_URL}/api/upload/${upload.key}?uploadId=${uploadId}&parts=2&finalize=1`, {
      method: 'PUT',
      headers: { Cookie: cookie },
    });
    assert.equal(finalize.status, 409);
  });

  it('rejects malformed chunk parameters', async () => {
    const { cookie } = await seedUserAndLogin('chunked-invalid');
    const prepared = await prepareImage(cookie);
    const upload = prepared.uploads[0];

    const noId = await fetch(`${BASE_URL}/api/upload/${upload.key}?part=1&parts=2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', Cookie: cookie },
      body: paddedPng(1024),
    });
    assert.equal(noId.status, 400);

    const tooManyParts = await fetch(
      `${BASE_URL}/api/upload/${upload.key}?uploadId=${crypto.randomUUID()}&part=1&parts=999`,
      { method: 'PUT', headers: { 'Content-Type': 'image/png', Cookie: cookie }, body: paddedPng(1024) },
    );
    assert.equal(tooManyParts.status, 400);
  });
});
