import assert from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { BASE_URL, loginUser, registerUser, resetDb, seedUserAndLogin } from './helpers/setup.ts';

// File scanning integration tests. Requires the dev:test server (port 8788).
//
// Flow under test: upload → file_scans row (sync steps 2-4) → async ClamAV
// verdict via the crowd webhook → serve-time blocking. The dev:test server
// carries a dummy CROWD_WEBHOOK_SECRET, so the webhook is signed exactly like
// the orchestrator would sign it (unsigned callbacks are rejected with 401).

// 8x8 RGBA PNG (strict-parser clean: chunk lengths and CRCs verified). The
// older attachments fixture has a malformed IDAT length and would never reach
// the pHash path.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGM4IafxHxmL2NxBwSNEAQBCE4cBj+PHdAAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex');
const HTML = Buffer.from('<!DOCTYPE html><html><body>not an image</body></html>');

async function prepare(cookie: string, filename: string, contentType: string) {
  const res = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ files: [{ filename, contentType }] }),
  });
  const data = (await res.json()) as { uploads?: Array<{ key: string; uploadUrl: string }> };
  return { status: res.status, key: data.uploads?.[0]?.key ?? '', uploadUrl: data.uploads?.[0]?.uploadUrl ?? '' };
}

async function upload(uploadUrl: string, cookie: string, body: Buffer, contentType: string) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, Cookie: cookie },
    body,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON error body
  }
  return { status: res.status, json };
}

async function scanRows(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE_URL}/api/test/file-scans`);
  assert.equal(res.status, 200, 'test inspector must be reachable');
  const data = (await res.json()) as { scans: Array<Record<string, unknown>> };
  return data.scans;
}

async function findScan(key: string, timeoutMs = 8000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = (await scanRows()).find((r) => r.r2_key === key) ?? null;
    if (row || Date.now() > deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForStatus(
  key: string,
  expected: string | string[],
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const wanted = Array.isArray(expected) ? expected : [expected];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = (await scanRows()).find((r) => r.r2_key === key) ?? null;
    if (row && wanted.includes(String(row.status))) return row;
    if (Date.now() > deadline) {
      throw new Error(`scan status for ${key} never became ${wanted.join('|')} (last: ${row?.status ?? 'none'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function loginAdmin(): Promise<string> {
  await resetDb();
  const creds = {
    email: 'admin@test.com',
    password: 'password123',
    username: 'remydrescarlet',
    display_name: 'Admin',
  };
  await registerUser(creds);
  const { cookie } = await loginUser(creds.email, creds.password);
  assert.ok(cookie, 'expected an admin session cookie');
  return cookie;
}

async function adminList(cookie: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE_URL}/api/admin/file-blocklist`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { entries: Array<Record<string, unknown>> };
  return data.entries;
}

async function adminDelete(cookie: string, id: unknown): Promise<number> {
  const res = await fetch(`${BASE_URL}/api/admin/file-blocklist/${String(id)}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  return res.status;
}

/** Remove a leftover sha256 entry from an earlier run so uploads can proceed. */
async function clearShaEntry(cookie: string, sha: string): Promise<void> {
  for (const entry of await adminList(cookie)) {
    if (entry.kind === 'sha256' && String(entry.value).toLowerCase() === sha) {
      await adminDelete(cookie, entry.id);
    }
  }
}

async function adminAdd(cookie: string, kind: string, value: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/api/admin/file-blocklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ kind, value, reason: 'integration test' }),
  });
  return res.status;
}

async function clearEntries(cookie: string, kind: string): Promise<void> {
  for (const entry of await adminList(cookie)) {
    if (entry.kind === kind) await adminDelete(cookie, entry.id);
  }
}

/** Flip exactly `count` low bits of a 16-hex hash, for distance tests. */
function flipLowBits(hash: string, count: number): string {
  const flipped = BigInt(`0x${hash}`) ^ ((1n << BigInt(count)) - 1n);
  return flipped.toString(16).padStart(16, '0');
}

async function postWebhook(params: Record<string, string>, body: unknown): Promise<number> {
  const query = new URLSearchParams({ type: 'file-scan', ...params });
  query.sort();
  const sig = createHmac('sha256', CROWD_WEBHOOK_SECRET).update(`/api/crowd/webhook?${query}`).digest('hex');
  query.set('sig', sig);
  const res = await fetch(`${BASE_URL}/api/crowd/webhook?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

// Dummy secret bound into the dev:test server (see package.json). Never a
// production value: it only lets the suite speak the webhook protocol.
const CROWD_WEBHOOK_SECRET = 'test-callback-secret';

describe('file scanning pipeline', () => {
  it('records a scan row with features for every upload', async () => {
    const { cookie } = await seedUserAndLogin(`scan${Date.now() % 100000}`);
    const prepared = await prepare(cookie, 'pic.png', 'image/png');
    assert.equal(prepared.status, 200, 'prepare must succeed');
    assert.ok(prepared.key && prepared.uploadUrl);

    const put = await upload(prepared.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(put.status, 200, `upload must pass the sync scan: ${JSON.stringify(put.json)}`);

    const row = await findScan(prepared.key);
    assert.ok(row, 'file_scans row must exist for the uploaded key');
    assert.equal(row.sha256, PNG_SHA256, 'sync features must record the full sha256');
    assert.equal(row.kind, 'image');
    assert.match(String(row.phash ?? ''), /^[0-9a-f]{16}$/, 'PNG uploads carry a pHash');
    assert.notEqual(row.status, 'infected');

    // The object is served while no async verdict blocks it.
    const img = await fetch(`${BASE_URL}/api/images/${prepared.key}`);
    assert.equal(img.status, 200, 'clean image must be served');
  });

  it('accepts the browser spellings for .m4a and .wav', async () => {
    const { cookie } = await seedUserAndLogin(`alias${Date.now() % 100000}`);

    // .m4a reported as audio/x-m4a: an ftyp box always sniffs as video/mp4.
    const m4a = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(64)]);
    const m4aPrepared = await prepare(cookie, 'clip.m4a', 'audio/x-m4a');
    assert.equal(m4aPrepared.status, 200, 'prepare must accept the .m4a kind');
    const m4aPut = await upload(m4aPrepared.uploadUrl, cookie, m4a, 'audio/x-m4a');
    assert.equal(m4aPut.status, 200, `audio/x-m4a must upload: ${JSON.stringify(m4aPut.json)}`);

    // .wav reported as audio/x-wav: RIFF....WAVE.
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]);
    const wavPrepared = await prepare(cookie, 'clip.wav', 'audio/x-wav');
    assert.equal(wavPrepared.status, 200, 'prepare must accept the .wav kind');
    const wavPut = await upload(wavPrepared.uploadUrl, cookie, wav, 'audio/x-wav');
    assert.equal(wavPut.status, 200, `audio/x-wav must upload: ${JSON.stringify(wavPut.json)}`);
  });

  it('rejects type mismatches before the object reaches R2', async () => {
    const { cookie } = await seedUserAndLogin(`mism${Date.now() % 100000}`);

    // HTML bytes in a .png image slot: the attachment kind check rejects them
    // (text/html is not image content) before anything reaches the store.
    const htmlPrepared = await prepare(cookie, 'pic.png', 'image/png');
    assert.equal(htmlPrepared.status, 200);
    const htmlPut = await upload(htmlPrepared.uploadUrl, cookie, HTML, 'image/png');
    assert.equal(htmlPut.status, 400, 'HTML in a .png slot must be rejected');
    assert.equal(await findScan(htmlPrepared.key, 1500), null, 'rejected uploads leave no scan row');
    assert.equal((await fetch(`${BASE_URL}/api/images/${htmlPrepared.key}`)).status, 404);

    // PNG bytes in a .gif key declared as audio/mpeg: the attachment kind
    // check passes (the bytes sniff as an image), so the declared
    // Content-Type mismatch is what rejects them, with a typed code.
    const mismatchPrepared = await prepare(cookie, 'pic2.gif', 'image/gif');
    assert.equal(mismatchPrepared.status, 200);
    const mismatchPut = await upload(mismatchPrepared.uploadUrl, cookie, PNG, 'audio/mpeg');
    assert.equal(mismatchPut.status, 400, 'a cross-class declared Content-Type must be rejected');
    assert.equal(mismatchPut.json.code, 'type_mismatch');
    assert.equal(await findScan(mismatchPrepared.key, 1500), null);
    assert.equal((await fetch(`${BASE_URL}/api/images/${mismatchPrepared.key}`)).status, 404);

    // The same bytes with their real declared type do upload: file.type comes
    // from the extension, so a JPEG saved as .png (or PNG in a .gif key) is a
    // common, harmless disagreement between name and content.
    const renamedPrepared = await prepare(cookie, 'pic3.gif', 'image/gif');
    assert.equal(renamedPrepared.status, 200);
    const renamedPut = await upload(renamedPrepared.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(
      renamedPut.status,
      200,
      `image content behind a .gif key must be accepted: ${JSON.stringify(renamedPut.json)}`,
    );
    assert.ok(await findScan(renamedPrepared.key), 'the accepted upload must still be scanned');
  });

  it('blocks a blocklisted sha256 synchronously and supports admin CRUD', async () => {
    const admin = await loginAdmin();
    await clearShaEntry(admin, PNG_SHA256);

    const add = await fetch(`${BASE_URL}/api/admin/file-blocklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ kind: 'sha256', value: PNG_SHA256.toUpperCase(), reason: 'integration test' }),
    });
    assert.equal(add.status, 201, 'adding a valid entry must succeed');

    const invalid = await fetch(`${BASE_URL}/api/admin/file-blocklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ kind: 'sha256', value: 'not-a-digest' }),
    });
    assert.equal(invalid.status, 400, 'malformed entries must be rejected');

    const entries = await adminList(admin);
    const entry = entries.find((e) => e.kind === 'sha256' && String(e.value).toLowerCase() === PNG_SHA256);
    assert.ok(entry, 'the entry must be listed (normalized to lowercase)');

    const { cookie } = await seedUserAndLogin(`blk${Date.now() % 100000}`);
    const prepared = await prepare(cookie, 'pic.png', 'image/png');
    const put = await upload(prepared.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(put.status, 400, 'blocklisted content must never be stored');
    assert.equal(put.json.code, 'file_blocked');

    const removed = await adminDelete(admin, entry.id);
    assert.equal(removed, 200, 'the entry must be removable');

    const retryPrepared = await prepare(cookie, 'again.png', 'image/png');
    const retry = await upload(retryPrepared.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(retry.status, 200, 'uploads must recover once the entry is deleted');
  });

  it('matches phash entries end-to-end at the distance boundary', async () => {
    const admin = await loginAdmin();

    const { cookie } = await seedUserAndLogin(`phash${Date.now() % 100000}`);
    const first = await prepare(cookie, 'pic.png', 'image/png');
    const firstPut = await upload(first.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(firstPut.status, 200, 'the fixture must upload clean first');

    const row = await findScan(first.key);
    assert.ok(row, 'the scan row carries the phash');
    const hash = String(row.phash);
    assert.match(hash, /^[0-9a-f]{16}$/, 'the fixture PNG must produce a phash');

    // Distance 8 is the threshold: a similar image is blocked.
    assert.equal(await adminAdd(admin, 'phash', flipLowBits(hash, 8)), 201);
    const near = await prepare(cookie, 'near.png', 'image/png');
    const nearPut = await upload(near.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(nearPut.status, 400, 'a distance-8 phash must block');
    assert.equal(nearPut.json.code, 'file_blocked');
    await clearEntries(admin, 'phash');

    // Distance 9 is outside it: the same bytes upload again.
    assert.equal(await adminAdd(admin, 'phash', flipLowBits(hash, 9)), 201);
    const far = await prepare(cookie, 'far.png', 'image/png');
    const farPut = await upload(far.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(farPut.status, 200, 'a distance-9 phash must not block');
    await clearEntries(admin, 'phash');
  });

  it('blocks serving and auto-blocklists once ClamAV reports infected', async () => {
    const admin = await loginAdmin();
    await clearShaEntry(admin, PNG_SHA256);

    const { cookie } = await seedUserAndLogin(`inf${Date.now() % 100000}`);
    const prepared = await prepare(cookie, 'pic.png', 'image/png');
    const put = await upload(prepared.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(put.status, 200, 'upload must pass before the async verdict');

    const row = await findScan(prepared.key);
    assert.ok(row, 'scan row must exist before the callback');
    const sha = String(row.sha256);

    const webhookStatus = await postWebhook(
      { key: prepared.key, kind: 'clamav', sha: sha.slice(0, 16) },
      {
        taskId: 'test-task-infected',
        status: 'done',
        result: { output: { exitCode: 1, stdout: 'input.png: Eicar-Test-Signature FOUND', stderr: '' } },
      },
    );
    assert.equal(webhookStatus, 200);

    const infected = await waitForStatus(prepared.key, 'infected');
    assert.equal(infected.detail, 'Eicar-Test-Signature', 'the signature name must be recorded');

    const img = await fetch(`${BASE_URL}/api/images/${prepared.key}`);
    assert.equal(img.status, 404, 'infected objects must stop being served');

    const entries = await adminList(admin);
    const auto = entries.find((e) => e.kind === 'sha256' && String(e.value).toLowerCase() === sha);
    assert.ok(auto, 'infection must auto-add the sha256 to the blocklist');

    // Cleanup: without this, later runs could not upload the same PNG bytes.
    assert.equal(await adminDelete(admin, auto.id), 200);
  });

  it('marks the row clean on a clean ClamAV verdict', async () => {
    const { cookie } = await seedUserAndLogin(`cln${Date.now() % 100000}`);
    const prepared = await prepare(cookie, 'pic.png', 'image/png');
    const put = await upload(prepared.uploadUrl, cookie, PNG, 'image/png');
    assert.equal(put.status, 200);

    const row = await findScan(prepared.key);
    assert.ok(row);
    const sha = String(row.sha256);

    const webhookStatus = await postWebhook(
      { key: prepared.key, kind: 'clamav', sha: sha.slice(0, 16) },
      {
        taskId: 'test-task-clean',
        status: 'done',
        result: { output: { exitCode: 0, stdout: '', stderr: '' } },
      },
    );
    assert.equal(webhookStatus, 200);

    await waitForStatus(prepared.key, 'clean');
    const img = await fetch(`${BASE_URL}/api/images/${prepared.key}`);
    assert.equal(img.status, 200, 'clean objects stay served');
  });
});
