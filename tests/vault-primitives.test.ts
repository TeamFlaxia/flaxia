// Vault cryptography primitives (docs/e2ee.md).
//
// Two kinds of coverage:
//   1. Known-answer vectors — pin the KDF and the wire encodings so a change
//      to parameters or formats cannot ship silently and strand every stored
//      envelope.
//   2. Behaviour — every unlock path opens the same VK, every wrong input
//      fails, and each AAD context actually binds the ciphertext to its role.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTEXT_PAYLOAD,
  CONTEXT_VK_PASSWORD,
  CONTEXT_VK_RECOVERY,
  createDeviceKey,
  createVaultEnvelope,
  DEFAULT_VAULT_KDF_PARAMS,
  decodeB64,
  decodeWrapped,
  decryptVaultItem,
  deriveVaultKe,
  deriveVaultKeBits,
  encodeB64,
  encodeWrapped,
  encryptVaultItem,
  isValidB64,
  isValidRecoveryPhrase,
  isValidVaultItemId,
  isValidVaultKdfParams,
  isValidWrappedKey,
  normalizeRecoveryPhrase,
  rewrapItemKeyForVaultKey,
  rewrapVaultKeyForPassword,
  unlockVaultWithPassword,
  unlockVaultWithRecovery,
  unwrapSecret,
  unwrapVaultKeyWithDevice,
  VAULT_IV_BYTES,
  VAULT_KDF_ITERATIONS,
  wrapSecret,
  wrapVaultKeyForDevice,
} from '../src/lib/vault/primitives.ts';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'correct horse battery staple';

function salt00to0f(): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, i) => i);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function expectReject(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(promise, /unable to decrypt|recovery phrase|malformed/, `${label} should have failed`);
}

// ─── Known-answer vectors ────────────────────────────────────────────────────

test('PBKDF2 vector: default parameters are unchanged', async () => {
  // If VAULT_KDF_ITERATIONS ever changes, every stored envelope stops opening.
  assert.equal(VAULT_KDF_ITERATIONS, 600_000);
  assert.equal(DEFAULT_VAULT_KDF_PARAMS.alg, 'PBKDF2-SHA256');
  assert.equal(DEFAULT_VAULT_KDF_PARAMS.iterations, 600_000);

  const bits = await deriveVaultKeBits(PASSWORD, salt00to0f(), DEFAULT_VAULT_KDF_PARAMS);
  assert.equal(
    encodeB64(bits),
    '7xdxRO7JQgy8EJPSqLNEqSvFBtDU7JwCjdGfgyTYweY=',
    'PBKDF2 output changed — stored vault envelopes would become unopenable',
  );
});

test('PBKDF2 vector: iteration count is part of the input', async () => {
  const bits = await deriveVaultKeBits(PASSWORD, salt00to0f(), { alg: 'PBKDF2-SHA256', iterations: 100_000 });
  assert.equal(toBase64Hex('49d49c25f597846209f0d92e7770ab64e1c75e94b4ce6c509265ee67175d2a1e'), encodeB64(bits));
});

function toBase64Hex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return encodeB64(bytes);
}

test('PBKDF2 vector: the secret is part of the input', async () => {
  const a = await deriveVaultKeBits('pw', salt00to0f());
  const b = await deriveVaultKeBits('px', salt00to0f());
  assert.notEqual(encodeB64(a), encodeB64(b));
});

test('encoding vectors are stable', () => {
  const bytes = salt00to0f();
  assert.equal(encodeB64(bytes), 'AAECAwQFBgcICQoLDA0ODw==');
  assert.deepEqual(decodeB64('AAECAwQFBgcICQoLDA0ODw=='), bytes);
  assert.equal(encodeWrapped(bytes, new Uint8Array([1, 2, 3])), 'AAECAwQFBgcICQoLDA0ODw==.AQID');
});

// ─── Wire format validation (used by the API layer) ─────────────────────────

test('wrapped-value validation accepts the canonical form and nothing else', () => {
  const iv = new Uint8Array(VAULT_IV_BYTES).fill(7);
  const ct = new Uint8Array(48).fill(9);
  const valid = encodeWrapped(iv, ct);
  assert.ok(isValidWrappedKey(valid));
  assert.ok(decodeWrapped(valid));

  assert.ok(!isValidWrappedKey('missing-dot'));
  assert.ok(!isValidWrappedKey(`${valid}.extra`));
  assert.ok(!isValidWrappedKey(''), 'empty is rejected');
  assert.ok(!isValidWrappedKey(42 as unknown as string));
  // IV too short: `AQID` decodes to 3 bytes.
  assert.ok(!isValidWrappedKey('AQID.AQID'), 'short IV is rejected');
  // Ciphertext shorter than a GCM tag cannot be authentic.
  assert.ok(!isValidWrappedKey(`${encodeB64(iv)}.${encodeB64(new Uint8Array(8))}`), 'tag-less body rejected');
  assert.equal(decodeWrapped('nope'), null);
});

test('base64 validation checks length when a size is required', () => {
  assert.ok(isValidB64('AAECAwQFBgcICQoLDA0ODw==', 16));
  assert.ok(!isValidB64('AAECAwQFBgcICQoLDA0ODw==', 32));
  assert.ok(!isValidB64(''));
  assert.ok(!isValidB64(null));
});

test('kdf params are an allowlist with a floor', () => {
  assert.ok(isValidVaultKdfParams({ alg: 'PBKDF2-SHA256', iterations: 600_000 }));
  assert.ok(isValidVaultKdfParams({ alg: 'PBKDF2-SHA256', iterations: 100_000 }), 'floor is inclusive');
  assert.ok(!isValidVaultKdfParams({ alg: 'PBKDF2-SHA256', iterations: 99_999 }), 'no cheap KDFs');
  assert.ok(!isValidVaultKdfParams({ alg: 'PBKDF2-SHA512', iterations: 600_000 }));
  assert.ok(!isValidVaultKdfParams({ alg: 'raw', iterations: 600_000 }));
  assert.ok(!isValidVaultKdfParams(null));
  assert.ok(!isValidVaultKdfParams('PBKDF2-SHA256'));
});

test('vault item ids are validated before becoming AAD', () => {
  assert.ok(isValidVaultItemId('abcDEF123_-'));
  assert.ok(!isValidVaultItemId('short'), 'too short');
  assert.ok(!isValidVaultItemId('a'.repeat(41)), 'too long');
  assert.ok(!isValidVaultItemId('has spaces here'), 'charset');
  assert.ok(!isValidVaultItemId(null));
});

// ─── Recovery phrase normalisation ───────────────────────────────────────────

test('recovery phrase normalisation makes whitespace canonical', () => {
  const messy = `\n  ${PHRASE.replace(/ /g, '   ')}  \n`;
  assert.equal(normalizeRecoveryPhrase(messy), PHRASE);
  assert.equal(recoveryWordCount(PHRASE), 12);
  assert.ok(isValidRecoveryPhrase(PHRASE));
  assert.ok(isValidRecoveryPhrase('one two three four five six seven eight nine ten eleven twelve'));
  assert.ok(!isValidRecoveryPhrase('one two three'), 'too few words');
  assert.ok(!isValidRecoveryPhrase(''), 'empty');
});

function recoveryWordCount(phrase: string): number {
  return normalizeRecoveryPhrase(phrase).split(' ').filter(Boolean).length;
}

// ─── Envelope ────────────────────────────────────────────────────────────────

test('both unlock paths recover the same vault key', async () => {
  const { envelope, vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  assert.equal(vk.length, 32);
  assert.equal(envelope.vk_version, 1);
  assert.ok(isValidB64(envelope.salt, 16));
  assert.ok(isValidB64(envelope.recovery_salt, 16));
  assert.ok(isValidWrappedKey(envelope.wrapped_vk));
  assert.ok(isValidWrappedKey(envelope.recovery_blob));

  const viaPassword = await unlockVaultWithPassword(PASSWORD, envelope);
  const viaRecovery = await unlockVaultWithRecovery(PHRASE, envelope);
  assert.ok(equalBytes(viaPassword, vk), 'password path must yield VK');
  assert.ok(equalBytes(viaRecovery, vk), 'recovery path must yield VK');
  assert.ok(equalBytes(viaPassword, viaRecovery));
});

test('the two paths use independent salts, so equal secrets stay independent', async () => {
  // A user who picks their password as their recovery phrase must not collapse
  // the two envelopes into one.
  const { envelope } = await createVaultEnvelope(PHRASE, PHRASE);
  assert.notEqual(envelope.salt, envelope.recovery_salt);
  assert.notEqual(envelope.wrapped_vk, envelope.recovery_blob);
  const vk = await unlockVaultWithPassword(PHRASE, envelope);
  assert.ok(equalBytes(vk, await unlockVaultWithRecovery(PHRASE, envelope)));
});

test('wrong password and wrong phrase are both rejected', async () => {
  const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
  await expectReject(unlockVaultWithPassword('wrong password', envelope), 'wrong password');
  await expectReject(unlockVaultWithRecovery(`${PHRASE} extra extra extra extra extra`, envelope), 'wrong phrase');
});

test('the password and recovery contexts are not interchangeable', async () => {
  // Same derived key both times — only the AAD differs, so this isolates the
  // context binding from the (already independent) salts.
  const secret = PASSWORD;
  const salt = salt00to0f();
  const kek = await deriveVaultKe(secret, salt);
  const value = decodeB64(encodeB64(new Uint8Array(32).fill(3)));
  const wrapped = await wrapSecret(kek, value, CONTEXT_VK_PASSWORD);
  await expectReject(unwrapSecret(kek, wrapped, CONTEXT_VK_RECOVERY), 'same key, wrong context');
  const opened = await unwrapSecret(kek, wrapped, CONTEXT_VK_PASSWORD);
  assert.ok(equalBytes(opened, value));
});

test('a re-wrapped vault key opens under the new password only', async () => {
  const { envelope, vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const salt = decodeB64(envelope.salt);
  const newWrapped = await rewrapVaultKeyForPassword(vk, 'brandnewpass1', salt, envelope.kdf_params);

  const viaNew = await unlockVaultWithPassword('brandnewpass1', { ...envelope, wrapped_vk: newWrapped });
  assert.ok(equalBytes(viaNew, vk));
  await expectReject(
    unlockVaultWithPassword(PASSWORD, { ...envelope, wrapped_vk: newWrapped }),
    'old password after re-wrap',
  );
});

test('two wraps of the same value differ (IVs are never reused)', async () => {
  const { envelope, vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const salt = decodeB64(envelope.salt);
  const a = await rewrapVaultKeyForPassword(vk, PASSWORD, salt, envelope.kdf_params);
  const b = await rewrapVaultKeyForPassword(vk, PASSWORD, salt, envelope.kdf_params);
  assert.notEqual(a, b, 'deterministic ciphertext would mean a repeated IV');
  assert.ok(equalBytes(await unlockVaultWithPassword(PASSWORD, { ...envelope, wrapped_vk: a }), vk));
  assert.ok(equalBytes(await unlockVaultWithPassword(PASSWORD, { ...envelope, wrapped_vk: b }), vk));
});

test('a tampered envelope is rejected', async () => {
  const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
  const parsed = decodeWrapped(envelope.wrapped_vk);
  assert.ok(parsed);
  const flipped = Uint8Array.from(parsed.ciphertext);
  flipped[flipped.length - 1] ^= 0xff;
  await expectReject(
    unlockVaultWithPassword(PASSWORD, { ...envelope, wrapped_vk: encodeWrapped(parsed.iv, flipped) }),
    'tampered wrap',
  );
});

// ─── Devices ─────────────────────────────────────────────────────────────────

test('a device key wraps and unwraps VK', async () => {
  const { vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const deviceKey = await createDeviceKey();
  assert.equal(deviceKey.extractable, false, 'device keys must not be exportable');

  const wrapped = await wrapVaultKeyForDevice(vk, deviceKey);
  assert.ok(isValidWrappedKey(wrapped));
  const recovered = await unwrapVaultKeyWithDevice(wrapped, deviceKey);
  assert.ok(equalBytes(recovered, vk));

  const otherDevice = await createDeviceKey();
  await expectReject(unwrapVaultKeyWithDevice(wrapped, otherDevice), 'another device');
});

// ─── Items ───────────────────────────────────────────────────────────────────

const ITEM_ID = 'item_abcDEF123';

test('an item round-trips through two key layers', async () => {
  const { vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const body = new TextEncoder().encode('secret draft: launch at dawn');
  const item = await encryptVaultItem(vk, ITEM_ID, body);

  assert.ok(isValidWrappedKey(item.item_key_wrapped));
  assert.ok(isValidWrappedKey(item.payload));
  assert.equal(item.item_id, ITEM_ID);

  const out = await decryptVaultItem(vk, ITEM_ID, item.item_key_wrapped, item.payload);
  assert.ok(equalBytes(out, body));
});

test('an item payload cannot be moved to another row', async () => {
  // item_id is AAD on both layers, so a server that swaps rows breaks them.
  const { vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const item = await encryptVaultItem(vk, ITEM_ID, new TextEncoder().encode('body'));
  await expectReject(
    decryptVaultItem(vk, 'item_otherXYZ987', item.item_key_wrapped, item.payload),
    'payload read under a different id',
  );
});

test('the wrong vault key cannot read an item', async () => {
  const { vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const other = await createVaultEnvelope(PASSWORD, PHRASE);
  const item = await encryptVaultItem(vk, ITEM_ID, new TextEncoder().encode('body'));
  await expectReject(decryptVaultItem(other.vk, ITEM_ID, item.item_key_wrapped, item.payload), 'foreign vault key');
});

test('vault key rotation re-wraps item keys without touching payloads', async () => {
  // Device revocation path: VK changes, payloads stay byte-identical.
  const { vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const body = new TextEncoder().encode('revoke a device, keep the data');
  const item = await encryptVaultItem(vk, ITEM_ID, body);
  const payloadBefore = item.payload;

  const newVk = crypto.getRandomValues(new Uint8Array(32));
  const rewrappedKey = await rewrapItemKeyForVaultKey(vk, newVk, ITEM_ID, item.item_key_wrapped);

  assert.equal(item.payload, payloadBefore, 'payload must not be rewritten');
  const read = await decryptVaultItem(newVk, ITEM_ID, rewrappedKey, item.payload);
  assert.ok(equalBytes(read, body));
  // The revoked holder of the old VK keeps the payload but can no longer reach
  // the item key... and the re-wrapped key must not open under the old VK.
  await expectReject(decryptVaultItem(vk, ITEM_ID, rewrappedKey, item.payload), 'old vault key after rotation');
});

test('payload context differs from item-key context', () => {
  assert.notEqual(CONTEXT_PAYLOAD, CONTEXT_VK_PASSWORD);
});
