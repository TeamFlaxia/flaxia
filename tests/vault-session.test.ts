// The in-memory vault session (docs/e2ee.md): unlock outcome classification,
// the enable round-trip against the real dev:test server, and re-wrap refusal
// paths.
//
// session.ts speaks browser-style relative URLs ('/api/...') and relies on an
// ambient session cookie, so global fetch is wrapped for this file: relative
// paths resolve against BASE_URL, the cookie is injected, and two fault modes
// can be injected on demand — a dead network (the request throws) and a
// hostile stored envelope (one-shot response override). Everything else is
// proxied to the real server, so enable → fetch → unlock is a genuine E2E
// path, not a mock.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { prepareVaultRewrap } from '../src/lib/vault/client.ts';
import { generateEphemeralKeyPair, wrapVaultKeyForPairing } from '../src/lib/vault/pairing.ts';
import {
  DEFAULT_VAULT_KDF_PARAMS,
  encodeB64,
  isValidRecoveryPhrase,
  unlockVaultWithPassword,
} from '../src/lib/vault/primitives.ts';
import {
  adoptPairedVaultKey,
  enableVault,
  generateRecoveryPhrase,
  getVaultKey,
  isVaultUnlocked,
  lockVault,
  subscribeVault,
  unlockVault,
} from '../src/lib/vault/session.ts';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

const PASSWORD = 'password123';
const NEW_PASSWORD = 'brandnewpass1';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

// ─── fetch stub ─────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch.bind(globalThis);
let sessionCookie = '';
/** Throw on the next vault-keys request instead of reaching the server. */
let failNextKeys = false;
/** One-shot response body for the next vault-keys request. */
let overrideKeysBody: unknown = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!raw.startsWith('/')) return realFetch(input, init);

  const url = `${BASE_URL}${raw}`;
  if (raw.startsWith('/api/vault/keys')) {
    if (failNextKeys) {
      failNextKeys = false;
      throw new TypeError('network down');
    }
    if (overrideKeysBody !== null) {
      const body = overrideKeysBody;
      overrideKeysBody = null;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  const headers = new Headers(init?.headers);
  if (sessionCookie) headers.set('Cookie', sessionCookie);
  return realFetch(url, { ...init, headers });
}) as typeof fetch;

interface KeysResponse {
  enabled?: boolean;
  devices?: Array<{ id: string; state: string }>;
}

function readJson(path: string): Promise<KeysResponse> {
  return fetch(path, { headers: { Cookie: sessionCookie } }).then(async (res) => (await res.json()) as KeysResponse);
}

beforeEach(async () => {
  failNextKeys = false;
  overrideKeysBody = null;
  lockVault();
  await resetDb();
  const seeded = await seedUserAndLogin('1');
  sessionCookie = seeded.cookie;
});

// ─── enable ─────────────────────────────────────────────────────────────────

test('enableVault stores the envelope and registers this device', async () => {
  assert.equal(isVaultUnlocked(), false, 'the session starts locked');

  const result = await enableVault(PASSWORD, PHRASE);
  assert.deepEqual(result, { ok: true });
  assert.ok(isVaultUnlocked(), 'the session must hold VK after enabling');
  const vk = getVaultKey();
  assert.ok(vk && vk.length === 32, 'VK must be 32 bytes and in memory only');

  // Server side: the envelope landed, and THIS device is registered under the
  // id it chose — so it can be revoked later (threat T4).
  const keys = await readJson('/api/vault/keys');
  assert.equal(keys.enabled, true);
  const devices = (await readJson('/api/vault/devices')).devices ?? [];
  assert.equal(devices.length, 1, 'the enabling device self-registers in the same request');
  assert.equal(devices[0].state, 'active');

  // A second enable must not fight over rows.
  lockVault();
  assert.deepEqual(await enableVault(PASSWORD, PHRASE), { ok: false, error: 'already_exists' });
});

test('enableVault refuses a malformed phrase and creates nothing', async () => {
  const result = await enableVault(PASSWORD, `${PHRASE} extra`); // 13 words
  assert.deepEqual(result, { ok: false, error: 'failed' });
  assert.equal(isVaultUnlocked(), false, 'a failed enable must not hold VK');

  const keys = await readJson('/api/vault/keys');
  assert.equal(keys.enabled, false, 'nothing may exist after a failed enable');
});

// ─── unlock classification ──────────────────────────────────────────────────

test('unlockVault classifies wrong / network / malformed / ok', async () => {
  assert.deepEqual(await enableVault(PASSWORD, PHRASE), { ok: true });
  const original = getVaultKey();
  assert.ok(original);
  lockVault();
  assert.equal(getVaultKey(), null, 'lock drops VK from memory');

  // Wrong password: the KDF runs and GCM refuses — 'wrong', still locked.
  assert.equal(await unlockVault('not the password'), 'wrong');
  assert.equal(getVaultKey(), null, 'a failed unlock must not hold VK');

  // Dead network: the envelope never arrived. Not the password's fault.
  failNextKeys = true;
  assert.equal(await unlockVault(PASSWORD), 'network');

  // Hostile stored row: out-of-window KDF, valid-looking everything else.
  // Shape check must fire before any derivation.
  const wrapped = `${encodeB64(new Uint8Array(12))}.${encodeB64(new Uint8Array(32))}`;
  overrideKeysBody = {
    enabled: true,
    salt: encodeB64(new Uint8Array(16)),
    recovery_salt: encodeB64(new Uint8Array(16)),
    kdf_params: { alg: 'PBKDF2-SHA256', iterations: 10_000_001 },
    wrapped_vk: wrapped,
    recovery_blob: wrapped,
    vk_version: 1,
  };
  const started = Date.now();
  assert.equal(await unlockVault(PASSWORD), 'malformed');
  assert.ok(Date.now() - started < 1000, 'a malformed row must fail before the KDF, not after');

  // Missing fields are malformed too — never 'wrong'.
  overrideKeysBody = { enabled: true };
  assert.equal(await unlockVault(PASSWORD), 'malformed');

  // The real row, the right password.
  assert.equal(await unlockVault(PASSWORD), 'ok');
  assert.deepEqual(getVaultKey(), original, 'the same VK comes back from the server');
});

test('lock drops VK and subscribers see every transition', async () => {
  let notifications = 0;
  const unsubscribe = subscribeVault(() => {
    notifications++;
  });

  assert.deepEqual(await enableVault(PASSWORD, PHRASE), { ok: true });
  assert.equal(notifications, 1, 'unlock notifies once');
  lockVault();
  assert.equal(notifications, 2, 'lock notifies once');
  assert.equal(isVaultUnlocked(), false);

  unsubscribe();
  assert.equal(await unlockVault(PASSWORD), 'ok');
  assert.equal(notifications, 2, 'unsubscribed listeners stop firing');
});

// ─── recovery phrase ────────────────────────────────────────────────────────

test('generateRecoveryPhrase yields a 24-word checksum-valid mnemonic', () => {
  const phrase = generateRecoveryPhrase();
  assert.equal(phrase.split(' ').length, 24);
  assert.ok(validateMnemonic(phrase, wordlist), 'the BIP-39 checksum must verify');
  assert.ok(isValidRecoveryPhrase(phrase));
  assert.notEqual(phrase, generateRecoveryPhrase(), 'two phrases must not collide');
});

// ─── QR pairing adoption (the joiner side of the handshake) ─────────────────

// The full two-device handshake as the UI runs it: joiner creates a pairing
// and holds its ephemeral secret, approver wraps VK under the ECDH secret, the
// joiner polls and adopts the blob. This is the path a unit test of
// unwrapVaultKeyForPairing alone cannot catch — adoption must feed the
// ephemeral secret and approved_pub into the unwrap, not a device key.
test('adoptPairedVaultKey opens the handoff blob with the joiner secret', async () => {
  assert.deepEqual(await enableVault(PASSWORD, PHRASE), { ok: true });
  const vk = getVaultKey();
  assert.ok(vk);

  // Joiner: ephemeral keypair, publishes the public half, displays the QR.
  const joiner = generateEphemeralKeyPair();
  const created = await fetch('/api/vault/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Second laptop', peer_pub: encodeB64(joiner.publicKey) }),
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };

  // Approver: an already-unlocked device scans and wraps VK.
  const approver = generateEphemeralKeyPair();
  const wrapped = await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, id);
  const approved = await fetch(`/api/vault/devices/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved_pub: encodeB64(approver.publicKey), wrapped_vk: wrapped }),
  });
  assert.equal(approved.status, 200);

  // Joiner polls: the row is active and carries the blob + approver's public.
  const polled = (await (await fetch(`/api/vault/devices/${id}`)).json()) as {
    state: string;
    approved_pub?: string;
    wrapped_vk?: string;
  };
  assert.equal(polled.state, 'active');
  assert.ok(polled.wrapped_vk && polled.approved_pub, 'an approved row must carry both halves');

  // Simulate a fresh device: no VK in memory, then adopt as the joiner UI does.
  lockVault();
  assert.equal(getVaultKey(), null);
  const adopted = await adoptPairedVaultKey(polled.wrapped_vk, id, joiner.secretKey, polled.approved_pub);
  assert.equal(adopted, true, 'the joiner must open the blob with its own ephemeral secret');
  assert.deepEqual(getVaultKey(), vk, 'adoption must yield the same VK the approver wrapped');

  // Wrong ephemeral secret: GCM refuses, nothing may enter the session.
  lockVault();
  const impostor = generateEphemeralKeyPair();
  assert.equal(
    await adoptPairedVaultKey(polled.wrapped_vk, id, impostor.secretKey, polled.approved_pub),
    false,
    'a secret that did not participate in the handshake must not open the blob',
  );
  assert.equal(getVaultKey(), null, 'a failed adoption must not hold VK');

  // Wrong approved_pub (the approver's half swapped): same refusal.
  const stranger = generateEphemeralKeyPair();
  assert.equal(
    await adoptPairedVaultKey(polled.wrapped_vk, id, joiner.secretKey, encodeB64(stranger.publicKey)),
    false,
    'the approver public half is bound into the HKDF output',
  );
  assert.equal(getVaultKey(), null);

  // Wrong pairing id: the id is in the KDF info and the AAD.
  assert.equal(
    await adoptPairedVaultKey(polled.wrapped_vk, `${id}x`, joiner.secretKey, polled.approved_pub),
    false,
    'a blob cannot be replayed into another pairing id',
  );
  assert.equal(getVaultKey(), null);

  // Malformed approved_pub: fails before any crypto, still no VK.
  assert.equal(await adoptPairedVaultKey(polled.wrapped_vk, id, joiner.secretKey, '!!!'), false);
  assert.equal(getVaultKey(), null);
});

// ─── password change preparation ────────────────────────────────────────────

test('prepareVaultRewrap: none / ok / unlock_failed / error', async () => {
  // No vault yet: nothing to carry over.
  assert.deepEqual(await prepareVaultRewrap(PASSWORD, NEW_PASSWORD), { status: 'none' });

  assert.deepEqual(await enableVault(PASSWORD, PHRASE), { ok: true });
  const vk = getVaultKey();
  assert.ok(vk);
  lockVault();

  // Wrong current password: the user can retry — this is NOT 'error'.
  assert.deepEqual(await prepareVaultRewrap('not the password', NEW_PASSWORD), { status: 'unlock_failed' });

  // Hostile row: a shape failure can never open, so refuse outright instead
  // of inviting endless retypes of a correct password.
  overrideKeysBody = {
    enabled: true,
    salt: '!!!',
    kdf_params: DEFAULT_VAULT_KDF_PARAMS,
    wrapped_vk: 'x.y',
    vk_version: 1,
  };
  assert.deepEqual(await prepareVaultRewrap(PASSWORD, NEW_PASSWORD), { status: 'error' });

  overrideKeysBody = { enabled: true }; // missing fields
  assert.deepEqual(await prepareVaultRewrap(PASSWORD, NEW_PASSWORD), { status: 'error' });

  // Dead network: refuse rather than risk orphaning the envelope.
  failNextKeys = true;
  assert.deepEqual(await prepareVaultRewrap(PASSWORD, NEW_PASSWORD), { status: 'error' });

  // Correct password → fields that open under the NEW password only.
  const ok = await prepareVaultRewrap(PASSWORD, NEW_PASSWORD);
  assert.equal(ok.status, 'ok');
  if (ok.status !== 'ok') throw new Error('expected status ok');
  assert.deepEqual(await unlockVaultWithPassword(NEW_PASSWORD, ok.fields), vk);
  await assert.rejects(unlockVaultWithPassword(PASSWORD, ok.fields), 'the old password must stop opening it');
});
