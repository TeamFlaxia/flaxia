// QR device pairing API (docs/e2ee.md).
//
// This exercises the whole handshake over HTTP exactly as two real browsers
// would run it — joiner creates a pairing and polls, approver wraps VK under
// the ECDH secret — plus every way the exchange can be refused.
import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  buildPairingUri,
  generateEphemeralKeyPair,
  parsePairingUri,
  unwrapVaultKeyForPairing,
  wrapVaultKeyForPairing,
} from '../src/lib/vault/pairing.ts';
import { createVaultEnvelope, encodeB64 } from '../src/lib/vault/primitives.ts';
import { BASE_URL, createSrpProof, resetDb, seedUserAndLogin } from './helpers/setup.ts';

const PASSWORD = 'password123';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

function headers(cookie: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Cookie: cookie };
}

async function enableVault(cookie: string): Promise<{ vk: Uint8Array }> {
  const { envelope, vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const proof = await createSrpProof(cookie, PASSWORD);
  assert.ok(proof, 'should be able to prove the current password');
  const res = await fetch(`${BASE_URL}/api/vault/keys`, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify({ current_srp: proof, ...envelope }),
  });
  assert.equal(res.status, 201);
  return { vk };
}

interface CreateBody {
  label?: unknown;
  peer_pub?: unknown;
  ttl_seconds?: unknown;
}

function createPairing(cookie: string, body: CreateBody): Promise<Response> {
  return fetch(`${BASE_URL}/api/vault/devices`, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify(body),
  });
}

function getPairing(cookie: string, id: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/vault/devices/${id}`, { headers: headers(cookie) });
}

function approve(cookie: string, id: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/api/vault/devices/${id}/approve`, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('POST /api/vault/devices — joiner starts pairing', () => {
  beforeEach(resetDb);

  it('refuses to add a device to a vault that does not exist → 409', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const joiner = generateEphemeralKeyPair();
    const res = await createPairing(cookie, { label: 'Second laptop', peer_pub: encodeB64(joiner.publicKey) });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error?: string }).error, 'vault_not_enabled');
  });

  it('rejects malformed public keys and labels → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await enableVault(cookie);
    const joiner = generateEphemeralKeyPair();
    const pub = encodeB64(joiner.publicKey);

    for (const body of [
      { label: 'ok', peer_pub: 'not-base64!!' },
      { label: 'ok', peer_pub: encodeB64(new Uint8Array(16)) },
      { label: '', peer_pub: pub },
      { label: 'x'.repeat(41), peer_pub: pub },
      { peer_pub: pub },
    ]) {
      const res = await createPairing(cookie, body);
      assert.equal(res.status, 400, `should reject ${JSON.stringify(body).slice(0, 60)}`);
    }
  });

  it('issues an id, an expiry, and a scannable QR payload → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await enableVault(cookie);
    const joiner = generateEphemeralKeyPair();

    const res = await createPairing(cookie, { label: 'Phone', peer_pub: encodeB64(joiner.publicKey) });
    assert.equal(res.status, 201);
    const data = (await res.json()) as { id: string; expires_at: string };

    // The QR the joiner displays carries only id + public key, and both parse.
    const uri = buildPairingUri(data.id, joiner.publicKey);
    const parsed = parsePairingUri(uri);
    assert.ok(parsed);
    assert.equal(parsed.pairingId, data.id);

    const drift = Date.parse(data.expires_at) - Date.now();
    assert.ok(drift > 9 * 60_000 && drift < 11 * 60_000, `default TTL should be ~10 minutes, got ${drift}ms`);
  });
});

describe('POST /api/vault/devices/:id/approve — approver hands over VK', () => {
  beforeEach(resetDb);

  it('carries VK from an existing device to a new one', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { vk } = await enableVault(cookie);

    // Joiner side: ephemeral key, shows the QR.
    const joiner = generateEphemeralKeyPair();
    const created = await createPairing(cookie, { label: 'Second laptop', peer_pub: encodeB64(joiner.publicKey) });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };

    const pending = (await (await getPairing(cookie, id)).json()) as { state: string; expires_at: string };
    assert.equal(pending.state, 'pending');
    assert.ok(!('wrapped_vk' in pending) || !pending.wrapped_vk, 'a pending row hands over nothing');

    // Approver side: scans the QR, wraps VK under the shared secret.
    const approver = generateEphemeralKeyPair();
    const wrapped = await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, id);
    const approved = await approve(cookie, id, {
      approved_pub: encodeB64(approver.publicKey),
      wrapped_vk: wrapped,
    });
    assert.equal(approved.status, 200);

    // Joiner polls, then opens the envelope with its own ephemeral secret.
    const done = (await (await getPairing(cookie, id)).json()) as {
      state: string;
      approved_pub: string;
      wrapped_vk: string;
    };
    assert.equal(done.state, 'active');
    const recovered = await unwrapVaultKeyForPairing(
      done.wrapped_vk,
      joiner.secretKey,
      Uint8Array.from(Buffer.from(done.approved_pub, 'base64')),
      id,
    );
    assert.deepEqual(recovered, vk, 'the new device must end up with the same vault key');

    // ...and the QR itself still parses back to what the joiner published.
    const reparsed = parsePairingUri(buildPairingUri(id, joiner.publicKey));
    assert.ok(reparsed && reparsed.pairingId === id);
  });

  it('cannot be replayed → 409', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { vk } = await enableVault(cookie);
    const joiner = generateEphemeralKeyPair();
    const { id } = (await (
      await createPairing(cookie, { label: 'A', peer_pub: encodeB64(joiner.publicKey) })
    ).json()) as {
      id: string;
    };

    const approver = generateEphemeralKeyPair();
    const body = {
      approved_pub: encodeB64(approver.publicKey),
      wrapped_vk: await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, id),
    };
    assert.equal((await approve(cookie, id, body)).status, 200);

    // Approving again would overwrite the joiner's copy with a key it cannot open.
    const second = await approve(cookie, id, body);
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error?: string }).error, 'pairing_already_used');
  });

  it('refuses unknown pairings and malformed envelopes → 404/400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { vk } = await enableVault(cookie);

    const stranger = generateEphemeralKeyPair();
    // Well-formed blob on an id nobody created: the shape check passes, the
    // lookup must then fail (handlers validate before touching the database).
    const wellFormedDummy = `${encodeB64(new Uint8Array(12))}.${encodeB64(new Uint8Array(32))}`;
    const unknown = await approve(cookie, 'fffffffffffffffffffff', {
      approved_pub: encodeB64(stranger.publicKey),
      wrapped_vk: wellFormedDummy,
    });
    assert.equal(unknown.status, 404);

    const joiner = generateEphemeralKeyPair();
    const { id } = (await (
      await createPairing(cookie, { label: 'B', peer_pub: encodeB64(joiner.publicKey) })
    ).json()) as {
      id: string;
    };
    assert.equal((await approve(cookie, id, { approved_pub: 'nope', wrapped_vk: 'x.y' })).status, 400);

    const approver = generateEphemeralKeyPair();
    const blob = await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, id);
    assert.equal(
      (await approve(cookie, id, { approved_pub: encodeB64(approver.publicKey), wrapped_vk: `${blob}.extra` })).status,
      400,
      'blob must be exactly base64(iv).base64(ct)',
    );
  });

  it('an expired QR stops working → 410', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { vk } = await enableVault(cookie);
    const joiner = generateEphemeralKeyPair();

    const created = await createPairing(cookie, {
      label: 'Abandoned',
      peer_pub: encodeB64(joiner.publicKey),
      ttl_seconds: 1,
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };

    await sleep(1300);

    const polled = (await (await getPairing(cookie, id)).json()) as { state: string };
    assert.equal(polled.state, 'expired', 'the joiner must learn its QR died');

    const approver = generateEphemeralKeyPair();
    const res = await approve(cookie, id, {
      approved_pub: encodeB64(approver.publicKey),
      wrapped_vk: await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, id),
    });
    assert.equal(res.status, 410, 'a stale QR must not be approvable');
    assert.equal(((await res.json()) as { error?: string }).error, 'pairing_expired');
  });
});

describe('device management', () => {
  beforeEach(resetDb);

  it('lists state transitions and lets a device be revoked → 200', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const { vk } = await enableVault(cookie);
    const joiner = generateEphemeralKeyPair();
    const { id } = (await (
      await createPairing(cookie, { label: 'Old phone', peer_pub: encodeB64(joiner.publicKey) })
    ).json()) as {
      id: string;
    };

    const listBefore = (await (await fetch(`${BASE_URL}/api/vault/devices`, { headers: headers(cookie) })).json()) as {
      devices: Array<{ id: string; state: string; label: string }>;
    };
    assert.equal(listBefore.devices.length, 1);
    assert.equal(listBefore.devices[0].state, 'pending');
    assert.equal(listBefore.devices[0].label, 'Old phone');
    assert.ok(!('wrapped_vk' in listBefore.devices[0]), 'the list must not carry handoff blobs');

    const approver = generateEphemeralKeyPair();
    assert.equal(
      (
        await approve(cookie, id, {
          approved_pub: encodeB64(approver.publicKey),
          wrapped_vk: await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, id),
        })
      ).status,
      200,
    );

    const listAfter = (await (await fetch(`${BASE_URL}/api/vault/devices`, { headers: headers(cookie) })).json()) as {
      devices: Array<{ state: string; last_seen_at: string | null }>;
    };
    assert.equal(listAfter.devices[0].state, 'active');
    assert.ok(listAfter.devices[0].last_seen_at, 'approval records when the device was added');

    const removed = await fetch(`${BASE_URL}/api/vault/devices/${id}`, {
      method: 'DELETE',
      headers: headers(cookie),
    });
    assert.equal(removed.status, 200);
    assert.equal((await getPairing(cookie, id)).status, 404, 'a revoked device disappears');
    assert.equal(
      (await fetch(`${BASE_URL}/api/vault/devices/${id}`, { method: 'DELETE', headers: headers(cookie) })).status,
      404,
      'revoking twice is a no-op, not an error path worth hiding',
    );
  });

  it('keeps devices scoped to their owner → 404', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await enableVault(cookie);
    const joiner = generateEphemeralKeyPair();
    const { id } = (await (
      await createPairing(cookie, { label: 'Mine', peer_pub: encodeB64(joiner.publicKey) })
    ).json()) as {
      id: string;
    };

    const other = await seedUserAndLogin('2');
    assert.equal((await getPairing(other.cookie, id)).status, 404);
    assert.equal(
      (
        await fetch(`${BASE_URL}/api/vault/devices/${id}`, {
          method: 'DELETE',
          headers: headers(other.cookie),
        })
      ).status,
      404,
    );
  });
});

describe('POST /api/vault/keys — the enabling device registers itself', () => {
  beforeEach(resetDb);

  /** Same id shape device.ts produces: 16 random bytes, base64url, 22 chars. */
  function localDeviceId(): string {
    return encodeB64(crypto.getRandomValues(new Uint8Array(16)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  async function enableAs(cookie: string, extra: Record<string, unknown>): Promise<Response> {
    const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
    const proof = await createSrpProof(cookie, PASSWORD);
    assert.ok(proof, 'should be able to prove the current password');
    return fetch(`${BASE_URL}/api/vault/keys`, {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify({ current_srp: proof, ...envelope, ...extra }),
    });
  }

  it('creates an active row under the client-chosen id → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const deviceId = localDeviceId();
    const res = await enableAs(cookie, { device_id: deviceId, device_label: 'Chrome on Linux' });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { device_id?: string }).device_id, deviceId);

    const list = await fetch(`${BASE_URL}/api/vault/devices`, { headers: headers(cookie) });
    const { devices } = (await list.json()) as { devices: Array<{ id: string; label: string; state: string }> };
    assert.equal(devices.length, 1, 'the enabling device must be revocable later (threat T4)');
    assert.equal(devices[0].id, deviceId, 'local record and server row must share one id');
    assert.equal(devices[0].state, 'active');
    assert.equal(devices[0].label, 'Chrome on Linux');
  });

  it('rejects a malformed device id before writing anything → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await enableAs(cookie, { device_id: 'not base64url!!', device_label: 'x' });
    assert.equal(res.status, 400);

    const keys = await fetch(`${BASE_URL}/api/vault/keys`, { headers: headers(cookie) });
    assert.equal(((await keys.json()) as { enabled?: boolean }).enabled, false, 'no half-enabled vault');
  });

  it('rejects a missing label when an id is supplied → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await enableAs(cookie, { device_id: localDeviceId() });
    assert.equal(res.status, 400);
  });

  it('still enables when no device fields are sent (older clients) → 201', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await enableAs(cookie, {});
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { device_id?: string | null }).device_id, null);
  });
});
