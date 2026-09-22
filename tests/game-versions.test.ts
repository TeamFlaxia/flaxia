import assert from 'node:assert';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { BASE_URL, loginUser, registerUser } from './helpers/setup.ts';

// Game versioning (rolling-update) integration tests.
//
// Runs against the dev server on BASE_URL (default http://localhost:8788).
// Each test uses a unique user so runs stay isolated.

const RUN = String(Date.now());
let seq = 0;

async function loginUnique(): Promise<string> {
  const s = `gv${RUN}_${++seq}`;
  const email = `${s}@test.com`;
  // Registration is SRP-only and login goes through the handshake, so both run
  // through the shared helpers rather than raw fetches.
  const reg = await registerUser({ email, password: 'password123', username: s, display_name: `GV ${s}` });
  assert.equal(reg.status, 201, 'expected registration to succeed');
  const { cookie } = await loginUser(email, 'password123');
  assert.ok(cookie, 'expected a session cookie after login');
  return cookie;
}

async function makeGameZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('index.html', '<!doctype html><html><body>game</body></html>');
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

async function createGamePost(cookie: string): Promise<string> {
  const prep = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'game.zip' }),
  });
  const prepData = (await prep.json()) as { postId?: string; zipUploadUrl?: string; zipKey?: string };
  assert.ok(prepData.postId && prepData.zipUploadUrl && prepData.zipKey, 'prepare should return game upload info');

  const zip = await makeGameZip();
  const upload = await fetch(prepData.zipUploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip', Cookie: cookie },
    body: zip,
  });
  assert.equal(upload.status, 200, 'zip upload should succeed');

  const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ postId: prepData.postId, zipKey: prepData.zipKey, text: 'my game' }),
  });
  assert.equal(commit.status, 200, 'commit should succeed');
  return prepData.postId!;
}

describe('game versions', () => {
  it('lists versions, archives v1, and updates payload_key on update', async () => {
    const cookie = await loginUnique();
    const postId = await createGamePost(cookie);

    const beforeRes = await fetch(`${BASE_URL}/api/posts/${postId}/versions`, { headers: { Cookie: cookie } });
    assert.equal(beforeRes.status, 200);
    assert.deepEqual((await beforeRes.json()).versions, [], 'no versions before first update');

    const prepRes = await fetch(`${BASE_URL}/api/posts/${postId}/versions/prepare`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(prepRes.status, 200, 'version prepare should succeed');
    const prep = (await prepRes.json()) as { versionId?: string; zipUploadUrl?: string };

    const zip = await makeGameZip();
    const uploadRes = await fetch(prep.zipUploadUrl!, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', Cookie: cookie },
      body: zip,
    });
    assert.equal(uploadRes.status, 200, 'version zip upload should succeed');

    const commitRes = await fetch(`${BASE_URL}/api/posts/${postId}/versions/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ versionId: prep.versionId, changelog: 'bug fixes' }),
    });
    assert.equal(commitRes.status, 200, 'version commit should succeed');

    const listRes = await fetch(`${BASE_URL}/api/posts/${postId}/versions`, { headers: { Cookie: cookie } });
    const list = (await listRes.json()) as { versions: Array<{ versionNumber: number; changelog: string | null }> };
    assert.ok(list.versions.length >= 2, 'should archive v1 and add the new version');
    const newest = list.versions[0];
    assert.equal(newest.versionNumber, 2, 'newest version should be v2');
    assert.equal(newest.changelog, 'bug fixes');

    const postRes = await fetch(`${BASE_URL}/api/posts/${postId}`, { headers: { Cookie: cookie } });
    const post = (await postRes.json()) as { payload_key?: string };
    assert.ok(post.payload_key?.startsWith('versions/'), 'payload_key should point at the latest version');
  });

  it('rejects versioning by a non-owner', async () => {
    const owner = await loginUnique();
    const postId = await createGamePost(owner);

    const other = await loginUnique();
    const res = await fetch(`${BASE_URL}/api/posts/${postId}/versions/prepare`, {
      method: 'POST',
      headers: { Cookie: other },
    });
    assert.equal(res.status, 403, 'non-owner should be forbidden from preparing a version');
  });

  it('rejects versioning a non-game post', async () => {
    const cookie = await loginUnique();
    const prep = await fetch(`${BASE_URL}/api/posts/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ filename: 'note.txt' }),
    });
    const prepData = (await prep.json()) as { postId?: string };
    const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: prepData.postId, text: 'just text' }),
    });
    assert.equal(commit.status, 200);

    const res = await fetch(`${BASE_URL}/api/posts/${prepData.postId}/versions/prepare`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 400, 'non-game posts cannot be versioned');
  });
});
