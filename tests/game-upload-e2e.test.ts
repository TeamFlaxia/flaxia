import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { zipStructureHash } from '../functions/lib/scan/zip-list.ts';
import { UPLOAD_CHUNK_BYTES } from '../shared/upload-limits.ts';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

// A 26 MiB ZIP built in memory (no large fixture in git). `level: 0` stores
// the padding verbatim so the archive itself stays above the 25 MiB ceiling.
const MIB = 1024 * 1024;
const BIG_GAME_BYTES = 26 * MIB;

function bigGameZip(): Uint8Array {
  const pad = new Uint8Array(BIG_GAME_BYTES);
  for (let offset = 0; offset < pad.length; offset += 4096) pad[offset] = (offset >>> 12) & 0xff;
  return zipSync(
    {
      'index.html': strToU8('<!doctype html><html><body>big game</body></html>'),
      'assets/pad.bin': pad,
    },
    { level: 0 },
  );
}

function partsOf(bytes: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
    parts.push(bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.length)));
  }
  return parts;
}

async function seedPlusUser(suffix: string): Promise<{ cookie: string; username: string }> {
  const { cookie, username } = await seedUserAndLogin(suffix);
  const seeded = await fetch(`${BASE_URL}/api/test/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, planId: 'flaxia_plus', status: 'active' }),
  });
  assert.equal(seeded.status, 200, await seeded.text());
  return { cookie, username };
}

async function uploadInParts(uploadUrl: string, bytes: Uint8Array, cookie: string): Promise<number> {
  const parts = partsOf(bytes);
  assert.ok(parts.length > 1, '26 MiB must be split into at least two 16 MiB parts');
  const uploadId = crypto.randomUUID();
  for (const [index, part] of parts.entries()) {
    const response = await fetch(`${uploadUrl}?uploadId=${uploadId}&part=${index + 1}&parts=${parts.length}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', Cookie: cookie },
      body: part,
    });
    assert.equal(response.status, 200, await response.text());
  }
  const finalize = await fetch(`${uploadUrl}?uploadId=${uploadId}&parts=${parts.length}&finalize=1`, {
    method: 'PUT',
    headers: { Cookie: cookie },
  });
  return finalize.status;
}

async function prepareGame(cookie: string) {
  const response = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'big-game.zip', contentType: 'application/zip' }),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as { postId: string; zipKey: string; zipUploadUrl: string };
}

async function prepareVersion(cookie: string, postId: string) {
  const response = await fetch(`${BASE_URL}/api/posts/${postId}/versions/prepare`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as { versionId: string; zipUploadUrl: string };
}

describe('Flaxia+ game uploads above 25MB', () => {
  beforeEach(resetDb);

  it('publishes a new 26MB game through the browser prepare → part → finalize → commit flow', async () => {
    const { cookie, username } = await seedPlusUser('big-game-new');
    const bytes = bigGameZip();
    assert.ok(bytes.byteLength > 25 * MIB);
    const prepared = await prepareGame(cookie);

    assert.equal(await uploadInParts(prepared.zipUploadUrl, bytes, cookie), 200);

    const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: prepared.postId, zipKey: prepared.zipKey, text: 'big game' }),
    });
    assert.equal(commit.status, 200, await commit.text());

    const feed = (await (await fetch(`${BASE_URL}/api/posts?username=${username}`)).json()) as {
      posts: Array<{ id: string; payload_key?: string; payloadKey?: string }>;
    };
    const post = feed.posts.find((entry) => entry.id === prepared.postId);
    assert.ok(post, 'committed game must appear in the author feed');

    const archive = await fetch(`${BASE_URL}/api/zip/${prepared.postId}`);
    assert.equal(archive.status, 200);
    assert.equal(archive.headers.get('content-length'), String(bytes.byteLength));
    await archive.body?.cancel();

    const scans = (await (await fetch(`${BASE_URL}/api/test/file-scans`)).json()) as {
      scans: Array<{ r2_key: string; structure_hash: string | null }>;
    };
    const scan = scans.scans.find((entry) => entry.r2_key === prepared.zipKey);
    assert.equal(scan?.structure_hash, zipStructureHash(bytes));
  });

  it('accepts a 26MB game version update for Flaxia+', async () => {
    const { cookie } = await seedPlusUser('big-game-version');
    const small = prepareGame(cookie);
    const smallPrepared = await small;

    const smallZip = zipSync({ 'index.html': strToU8('<html>small</html>') }, { level: 0 });
    const smallUpload = await fetch(smallPrepared.zipUploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', Cookie: cookie },
      body: smallZip,
    });
    assert.equal(smallUpload.status, 200, await smallUpload.text());
    const smallCommit = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        postId: smallPrepared.postId,
        zipKey: smallPrepared.zipKey,
        text: 'versioned game',
      }),
    });
    assert.equal(smallCommit.status, 200, await smallCommit.text());

    const version = await prepareVersion(cookie, smallPrepared.postId);
    const bytes = bigGameZip();
    assert.equal(await uploadInParts(version.zipUploadUrl, bytes, cookie), 200);

    const commit = await fetch(`${BASE_URL}/api/posts/${smallPrepared.postId}/versions/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ versionId: version.versionId, changelog: 'larger build' }),
    });
    assert.equal(commit.status, 200, await commit.text());

    // Without ?v= the ZIP endpoint must serve the current release, not the
    // initial upload; ?v= still selects an archived build explicitly.
    const currentZip = await fetch(`${BASE_URL}/api/zip/${smallPrepared.postId}`);
    assert.equal(currentZip.status, 200);
    assert.equal(currentZip.headers.get('content-length'), String(bytes.byteLength));
    assert.equal((await currentZip.arrayBuffer()).byteLength, bytes.byteLength);

    const versioned = await fetch(`${BASE_URL}/api/zip/${smallPrepared.postId}?v=${version.versionId}`);
    assert.equal(versioned.status, 200, await versioned.clone().text());
    assert.equal(versioned.headers.get('content-length'), String(bytes.byteLength));
    assert.equal((await versioned.arrayBuffer()).byteLength, bytes.byteLength);

    const missingVersion = await fetch(`${BASE_URL}/api/zip/${smallPrepared.postId}?v=does-not-exist`);
    assert.equal(missingVersion.status, 404);

    const list = (await (
      await fetch(`${BASE_URL}/api/posts/${smallPrepared.postId}/versions`, { headers: { Cookie: cookie } })
    ).json()) as { versions: Array<{ versionNumber: number; changelog: string | null }> };
    assert.equal(list.versions.length, 2, 'the original release is archived as v1 and the new build becomes v2');
    const latest = list.versions.find((entry) => entry.versionNumber === 2);
    assert.equal(latest?.changelog, 'larger build');
  });

  it('still rejects a 26MB game for a free account', async () => {
    const { cookie } = await seedUserAndLogin('big-game-free');
    const prepared = await prepareGame(cookie);
    const bytes = bigGameZip();

    const parts = partsOf(bytes);
    const uploadId = crypto.randomUUID();
    let finalizeStatus = 0;
    for (const [index, part] of parts.entries()) {
      const response = await fetch(
        `${prepared.zipUploadUrl}?uploadId=${uploadId}&part=${index + 1}&parts=${parts.length}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/zip', Cookie: cookie },
          body: part,
        },
      );
      assert.equal(response.status, 200, await response.text());
    }
    const finalize = await fetch(`${prepared.zipUploadUrl}?uploadId=${uploadId}&parts=${parts.length}&finalize=1`, {
      method: 'PUT',
      headers: { Cookie: cookie },
    });
    finalizeStatus = finalize.status;
    assert.equal(finalizeStatus, 413, await finalize.text());
  });
});
