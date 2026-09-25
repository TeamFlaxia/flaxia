import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  buildAttachmentKey,
  MAX_ATTACHMENTS,
  parseAttachmentKey,
  sequenceAttachments,
  validateAttachmentInputs,
} from '../functions/lib/attachments.ts';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

// 1x1 transparent PNG — enough for detectMimeType to see the magic bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function prepareMulti(cookie: string, filenames: string[]) {
  const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ files: filenames.map((filename) => ({ filename, contentType: 'image/png' })) }),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function uploadTo(url: string, cookie: string): Promise<number> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', Cookie: cookie },
    body: PNG,
  });
  return res.status;
}

/** Prepare + upload a post with `count` image attachments and commit it. */
async function createMediaPost(cookie: string, count = 2): Promise<{ postId: string; keys: string[] }> {
  const { status, data } = await prepareMulti(
    cookie,
    Array.from({ length: count }, (_, i) => `pic${i}.png`),
  );
  assert.equal(status, 200);
  const postId = data.postId as string;
  const uploads = data.uploads as Array<{ key: string; uploadUrl: string }>;
  assert.equal(uploads.length, count);
  for (const upload of uploads) {
    assert.equal(await uploadTo(upload.uploadUrl, cookie), 200);
  }
  const commitRes = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      postId,
      text: 'multi media post',
      attachments: uploads.map((u) => ({ key: u.key, kind: 'image' })),
    }),
  });
  assert.ok(commitRes.status === 200 || commitRes.status === 201, `commit failed: ${commitRes.status}`);
  return { postId, keys: uploads.map((u) => u.key) };
}

describe('attachment helpers (unit)', () => {
  it('builds and parses keys for every kind', () => {
    assert.equal(buildAttachmentKey('p1', 2, 'a.png'), 'gif/p1/2.png');
    assert.equal(buildAttachmentKey('p1', 1, 'a.mp3'), 'audio/p1/1.mp3');
    assert.equal(buildAttachmentKey('p1', 3, 'a.mp4'), 'video/p1/3.mp4');
    assert.equal(buildAttachmentKey('p1', 9, 'a.png'), null, 'position out of range');
    assert.equal(buildAttachmentKey('p1', 1, 'a.zip'), null, 'games are not attachments');

    const parsed = parseAttachmentKey('video/p1/4.webm');
    assert.deepEqual(parsed, { postId: 'p1', position: 4, kind: 'video', ext: '.webm' });
    assert.equal(parseAttachmentKey('gif/p1/5.png'), null, 'position must be 1-4');
    assert.equal(parseAttachmentKey('payload/p1.png'), null, 'legacy keys are not attachments');
  });

  it('derives the .webm key prefix from the content type', () => {
    assert.equal(buildAttachmentKey('p1', 1, 'clip.webm', 'audio/webm'), 'audio/p1/1.webm');
    assert.equal(buildAttachmentKey('p1', 1, 'clip.webm', 'video/webm'), 'video/p1/1.webm');
    assert.equal(buildAttachmentKey('p1', 1, 'clip.webm'), 'video/p1/1.webm');
  });

  it('validates client-supplied lists', () => {
    assert.equal(validateAttachmentInputs('nope'), 'attachments must be an array');
    assert.equal(validateAttachmentInputs([]), 'attachments must not be empty');
    assert.equal(
      validateAttachmentInputs(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ key: `gif/p/${i + 1}.png` }))),
      `Maximum ${MAX_ATTACHMENTS} attachments allowed`,
    );
    assert.equal(
      validateAttachmentInputs([{ key: 'gif/p/1.png', kind: 'video' }]),
      'Attachment kind mismatch for gif/p/1.png',
    );
    assert.equal(validateAttachmentInputs([{ key: 'evil.png' }]), 'Invalid attachment key: evil.png');
    assert.equal(validateAttachmentInputs([{ key: 'gif/p/1.png' }, { key: 'gif/p/2.png' }]), null);
    assert.equal(
      validateAttachmentInputs([{ key: 'gif/p/1.png' }, { key: 'gif/p/1.mp3' }]),
      'Duplicate attachment position',
    );
  });

  it('re-sequences positions following list order', () => {
    const records = sequenceAttachments([{ key: 'gif/p/3.png' }, { key: 'audio/p/1.mp3' }]);
    assert.deepEqual(
      records.map((r) => ({ position: r.position, kind: r.kind })),
      [
        { position: 1, kind: 'image' },
        { position: 2, kind: 'audio' },
      ],
    );
  });
});

describe('POST /api/posts/prepare — files[]', () => {
  beforeEach(resetDb);

  it('reserves upload slots for up to 4 media files → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { status, data } = await prepareMulti(cookie, ['a.png', 'b.png', 'c.png', 'd.png']);
    assert.equal(status, 200);
    const uploads = data.uploads as Array<{ key: string; kind: string }>;
    assert.equal(uploads.length, 4);
    assert.deepEqual(
      uploads.map((u) => u.kind),
      ['image', 'image', 'image', 'image'],
    );
    const postId = data.postId as string;
    assert.deepEqual(
      uploads.map((u) => parseAttachmentKey(u.key)?.position),
      [1, 2, 3, 4],
    );
    assert.ok(uploads.every((u) => u.key.startsWith(`gif/${postId}/`)));
  });

  it('rejects more than 4 files → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { status } = await prepareMulti(cookie, ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
    assert.equal(status, 400);
  });

  it('rejects game files in the files list → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ files: [{ filename: 'game.zip' }] }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unauthenticated prepare → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ filename: 'a.png' }] }),
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/posts/commit — attachments', () => {
  beforeEach(resetDb);

  it('commits a post with attachments and enriches on read → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId, keys } = await createMediaPost(cookie, 3);

    const res = await fetch(`${BASE_URL}/api/posts/${postId}`);
    assert.equal(res.status, 200);
    const post = (await res.json()) as { attachments?: Array<{ r2_key: string; kind: string; position: number }> };
    assert.equal(post.attachments?.length, 3);
    assert.deepEqual(
      post.attachments!.map((a) => a.position),
      [1, 2, 3],
    );
    assert.deepEqual(
      post.attachments!.map((a) => a.r2_key),
      keys,
    );
    assert.ok(post.attachments!.every((a) => a.kind === 'image'));
  });

  it('rejects attachments combined with legacy game keys → 422', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { data } = await prepareMulti(cookie, ['a.png']);
    const uploads = data.uploads as Array<{ key: string }>;
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        postId: data.postId,
        text: 'mixing',
        gifKey: 'gif/whatever/1.png',
        attachments: [{ key: uploads[0].key, kind: 'image' }],
      }),
    });
    assert.equal(res.status, 422);
  });

  it('rejects committing attachments onto another user’s pending post → 403', async () => {
    const { cookie: alice } = await seedUserAndLogin('1');
    const { cookie: bob } = await seedUserAndLogin('2');
    const { data } = await prepareMulti(alice, ['a.png']);
    const uploads = data.uploads as Array<{ key: string }>;

    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bob },
      body: JSON.stringify({
        postId: data.postId,
        text: 'hijack',
        attachments: [{ key: uploads[0].key, kind: 'image' }],
      }),
    });
    assert.equal(res.status, 403);
  });

  it('rejects a kind that does not match the key prefix → 422', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { data } = await prepareMulti(cookie, ['a.png']);
    const uploads = data.uploads as Array<{ key: string }>;
    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        postId: data.postId,
        text: 'wrong kind',
        attachments: [{ key: uploads[0].key, kind: 'audio' }],
      }),
    });
    assert.equal(res.status, 422);
  });
});

describe('PUT /api/posts/:id — attachment edits', () => {
  beforeEach(resetDb);

  async function legacyImagePost(cookie: string): Promise<{ postId: string; gifKey: string }> {
    const prep = await fetch(`${BASE_URL}/api/posts/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ filename: 'legacy.png' }),
    });
    const prepData = (await prep.json()) as { postId: string; gifUploadUrl: string; gifKey: string };
    assert.equal(await uploadTo(prepData.gifUploadUrl, cookie), 200);
    const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: prepData.postId, text: 'legacy post', gifKey: prepData.gifKey }),
    });
    assert.ok(commit.status === 200 || commit.status === 201, `commit failed: ${commit.status}`);
    return { postId: prepData.postId, gifKey: prepData.gifKey };
  }

  it('replaces the full attachment list, then clears it', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId, keys } = await createMediaPost(cookie, 3);

    // Shrink to a single attachment
    let res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ attachments: [{ key: keys[0], kind: 'image' }] }),
    });
    assert.equal(res.status, 200);
    let updated = (await res.json()) as { post: { attachments?: unknown[] } };
    assert.equal(updated.post.attachments?.length, 1);

    // Clear every attachment
    res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ attachments: [] }),
    });
    assert.equal(res.status, 200);
    updated = (await res.json()) as { post: { attachments?: unknown[] } };
    assert.equal(updated.post.attachments?.length, 0);

    const get = await fetch(`${BASE_URL}/api/posts/${postId}`);
    const post = (await get.json()) as { attachments?: unknown[] };
    assert.equal(post.attachments?.length ?? 0, 0);
  });

  it('rejects a non-array attachments value instead of clearing → 422', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId } = await createMediaPost(cookie, 2);

    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ attachments: {} }),
    });
    assert.equal(res.status, 422);

    const get = await fetch(`${BASE_URL}/api/posts/${postId}`);
    const post = (await get.json()) as { attachments?: unknown[] };
    assert.equal(post.attachments?.length, 2, 'a malformed list must not wipe attachments');
  });

  it('rejects attachments on a post that still has legacy keys → 422', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId } = await legacyImagePost(cookie);
    const prepRes = await fetch(`${BASE_URL}/api/posts/${postId}/prepare-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ filename: 'extra.png', contentType: 'image/png' }),
    });
    assert.equal(prepRes.status, 200);
    const prep = (await prepRes.json()) as { key: string };

    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ attachments: [{ key: prep.key, kind: 'image' }] }),
    });
    assert.equal(res.status, 422);
  });
});

describe('POST /api/posts/:id/prepare-media', () => {
  beforeEach(resetDb);

  it('reserves the next slot on an owned published post → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId, keys } = await createMediaPost(cookie, 1);

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/prepare-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ filename: 'second.png', contentType: 'image/png' }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { key: string; kind: string; position: number };
    assert.equal(data.kind, 'image');
    assert.equal(data.position, 2);
    assert.notEqual(data.key, keys[0]);
    assert.equal(parseAttachmentKey(data.key)?.postId, postId);
  });

  it('rejects a foreign user’s post → 403', async () => {
    const { cookie: alice } = await seedUserAndLogin('1');
    const { cookie: bob } = await seedUserAndLogin('2');
    const { postId } = await createMediaPost(alice, 1);

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/prepare-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bob },
      body: JSON.stringify({ filename: 'x.png', contentType: 'image/png' }),
    });
    assert.equal(res.status, 403);
  });

  it('rejects game files → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId } = await createMediaPost(cookie, 1);

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/prepare-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ filename: 'game.zip', contentType: 'application/zip' }),
    });
    assert.equal(res.status, 400);
  });

  it('hands out distinct slots for several files prepared in one session → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId, keys } = await createMediaPost(cookie, 1);

    const reserved = [keys[0]];
    const prepared: Array<{ key: string; position: number; uploadUrl: string }> = [];
    for (const name of ['b.png', 'c.png']) {
      const res = await fetch(`${BASE_URL}/api/posts/${postId}/prepare-media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ filename: name, contentType: 'image/png', reservedKeys: reserved }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as { key: string; position: number; uploadUrl: string };
      prepared.push(data);
      reserved.push(data.key);
    }
    assert.deepEqual(
      prepared.map((p) => p.position),
      [2, 3],
      'each prepared file must get its own slot',
    );

    for (const p of prepared) {
      assert.equal(await uploadTo(p.uploadUrl, cookie), 200);
    }

    // Without per-call reservations every slot came back as 2 and this PUT
    // failed with "Duplicate attachment position".
    const res = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        attachments: [{ key: keys[0], kind: 'image' }, ...prepared.map((p) => ({ key: p.key, kind: 'image' }))],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `edit failed: ${text}`);
    const updated = JSON.parse(text) as { post: { attachments?: unknown[] } };
    assert.equal(updated.post.attachments?.length, 3);
  });

  it('allocates from the slot embedded in the key after a removal → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId, keys } = await createMediaPost(cookie, 2);

    // Drop the first attachment: the survivor keeps key .../2.png but is
    // re-sequenced to position 1.
    const put = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ attachments: [{ key: keys[1], kind: 'image' }] }),
    });
    assert.equal(put.status, 200);

    const res = await fetch(`${BASE_URL}/api/posts/${postId}/prepare-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ filename: 'third.png', contentType: 'image/png' }),
    });
    assert.equal(res.status, 200, 'the freed slot must be reusable');
    const data = (await res.json()) as { key: string; position: number };
    assert.equal(data.position, 1, 'slot 1 was freed by the removal');
    assert.notEqual(data.key, keys[1]);
    assert.equal(parseAttachmentKey(data.key)?.postId, postId);
  });
});

describe('PUT /api/upload/:key — attachment ownership', () => {
  beforeEach(resetDb);

  it('rejects uploading to another user’s attachment key → 403', async () => {
    const { cookie: alice } = await seedUserAndLogin('1');
    const { cookie: bob } = await seedUserAndLogin('2');
    const { data } = await prepareMulti(alice, ['a.png']);
    const uploads = data.uploads as Array<{ uploadUrl: string }>;

    assert.equal(await uploadTo(uploads[0].uploadUrl, bob), 403);
    assert.equal(await uploadTo(uploads[0].uploadUrl, alice), 200);
  });
});

describe('quoted posts carry attachments', () => {
  beforeEach(resetDb);

  it('enriches quoted_post with the quoted post’s attachments', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { postId, keys } = await createMediaPost(cookie, 2);

    const res = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'quoting media', quotedPostId: postId }),
    });
    const text = await res.text();
    assert.ok(res.status === 200 || res.status === 201, `commit failed: ${text}`);
    const created = JSON.parse(text) as {
      post: { id: string; quoted_post?: { attachments?: Array<{ r2_key: string }> } | null };
    };
    const post = created.post;

    assert.ok(post.quoted_post, 'quoted_post must be present');
    assert.deepEqual(
      post.quoted_post!.attachments?.map((a) => a.r2_key),
      keys,
    );

    const get = await fetch(`${BASE_URL}/api/posts/${post.id}`);
    const fetched = (await get.json()) as { quoted_post?: { attachments?: unknown[] } | null };
    assert.equal(fetched.quoted_post?.attachments?.length, 2);
  });
});
