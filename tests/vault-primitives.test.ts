// Vault cryptography primitives (docs/e2ee.md).
//
// Three kinds of coverage:
//   1. Known-answer vectors — pin the KDF and the wire encodings so a change
//      to parameters or formats cannot ship silently and strand every stored
//      envelope. Includes published PBKDF2-HMAC-SHA256 vectors checked
//      independently against OpenSSL.
//   2. Behaviour — every unlock path opens the same VK, every wrong input
//      fails, and each AAD context actually binds the ciphertext to its role.
//   3. Hostile inputs — malformed envelopes, absurd/fractional KDF parameters,
//      wrong-size keys, and tampered bytes must fail fast (BEFORE any KDF run
//      where shape is concerned) with errors that do not blame the user's
//      password.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTEXT_ITEM_KEY,
  CONTEXT_PAYLOAD,
  CONTEXT_VK_DEVICE,
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
  generateVaultSalt,
  isEnvelopeShapeError,
  isValidB64,
  isValidRecoveryPhrase,
  isValidVaultItemId,
  isValidVaultKdfParams,
  isValidWrappedKey,
  normalizeRecoveryPhrase,
  rewrapItemKeyForVaultKey,
  rewrapVaultKeyForPassword,
  rewrapVaultKeyForRecovery,
  unlockVaultWithPassword,
  unlockVaultWithRecovery,
  unwrapSecret,
  unwrapVaultKeyWithDevice,
  VAULT_IV_BYTES,
  VAULT_KDF_ITERATIONS,
  VAULT_KDF_MAX_ITERATIONS,
  VAULT_KDF_MIN_ITERATIONS,
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

type RejectionPattern = RegExp | ((value: unknown) => unknown);

/**
 * Assert that a promise rejects with `pattern` AND does so almost instantly.
 * A shape error raised before the KDF must not be confused with a failure that
 * only surfaces after a 600k-iteration PBKDF2 run (or, worse, an unbounded
 * one) — the timeout is what proves the guard runs first.
 */
async function rejectsQuickly(label: string, promise: Promise<unknown>, pattern: RejectionPattern): Promise<void> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: still running after 2000ms — a shape error must fail before the KDF`)),
      2000,
    );
  });
  try {
    await Promise.race([assert.rejects(promise, pattern as never, label), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `${label}: rejected too slowly for a pre-derivation check (${elapsed}ms)`);
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

// ─── Published KDF vectors ──────────────────────────────────────────────────

test('PBKDF2 vector: published known-answer vectors (OpenSSL cross-check)', async () => {
  // PBKDF2-HMAC-SHA256, P = "password", S = "salt", dkLen = 32. RFC 6070
  // only publishes SHA-1 vectors; these are the widely published SHA-256
  // counterparts, each verified against an independent implementation
  // (OpenSSL's EVP_PBKDF2). Low iteration counts are legal at this layer on
  // purpose: the envelope-level window is enforced separately.
  const salt = new TextEncoder().encode('salt');
  const vectors: Array<[number, string]> = [
    [1, '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'],
    [2, 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43'],
    [4096, 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a'],
  ];
  for (const [iterations, expected] of vectors) {
    const bits = await deriveVaultKeBits('password', salt, { alg: 'PBKDF2-SHA256', iterations });
    assert.equal(encodeB64(bits), toBase64Hex(expected), `c=${iterations} must match the published vector`);
  }
});

// ─── KDF parameter abuse ────────────────────────────────────────────────────

test('kdf params are an integer window: floor, ceiling, and JSON oddities', () => {
  const kdf = (iterations: unknown): boolean => isValidVaultKdfParams({ alg: 'PBKDF2-SHA256', iterations });
  // Window boundaries are inclusive on both ends.
  assert.ok(kdf(VAULT_KDF_MIN_ITERATIONS), 'floor is inclusive');
  assert.ok(kdf(VAULT_KDF_MAX_ITERATIONS), 'ceiling is inclusive');
  assert.ok(!kdf(VAULT_KDF_MIN_ITERATIONS - 1), 'below the floor');
  assert.ok(!kdf(VAULT_KDF_MAX_ITERATIONS + 1), 'above the ceiling');
  // Absurd but INTEGRAL: Number.isInteger(1e15) is true, so only the ceiling
  // catches it — without which the client would grind PBKDF2 for hours.
  assert.ok(!kdf(1e15), 'integral but absurd');
  // Non-finite, fractional, non-numeric.
  assert.ok(!kdf(Infinity), 'Infinity');
  assert.ok(!kdf(-Infinity), '-Infinity');
  assert.ok(!kdf(Number.NaN), 'NaN');
  assert.ok(!kdf(600_000.5), 'fractional');
  assert.ok(!kdf('600000'), 'stringified');
  assert.ok(!kdf(null), 'null');
  assert.ok(!kdf(undefined), 'missing');
  // The exact wire attack: JSON may carry `1e999`, which parses to Infinity
  // and would otherwise reach storage as `null` via JSON.stringify and brick
  // the vault.
  const hostile = JSON.parse('{"alg":"PBKDF2-SHA256","iterations":1e999}') as { iterations: number };
  assert.equal(hostile.iterations, Infinity, 'JSON 1e999 parses to Infinity');
  assert.ok(!isValidVaultKdfParams(hostile), 'Infinity must be rejected');
});

test('the raw KDF refuses to start an invalid run', async () => {
  const salt = salt00to0f();
  // Each of these would otherwise be silently coerced by WebIDL (1e15 →
  // 3 269 632 iterations, producing a key nobody asked for), run unbounded, or
  // throw an unrelated OperationError — all must fail fast with our own
  // message, proving no derivation started. Negative counts are covered by the
  // same `iterations < 1` check that 0 exercises.
  for (const iterations of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001, 1e15]) {
    await rejectsQuickly(
      `iterations=${String(iterations)}`,
      deriveVaultKeBits(PASSWORD, salt, { alg: 'PBKDF2-SHA256', iterations }),
      /iterations must be an integer/,
    );
  }
});

test('a malformed envelope fails BEFORE any derivation', async () => {
  const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
  const hostile: Array<[string, Record<string, unknown>]> = [
    ['salt is not base64', { salt: '!!!not-base64!!!' }],
    ['salt decodes to 15 bytes', { salt: encodeB64(new Uint8Array(15)) }],
    ['salt missing', { salt: undefined }],
    ['kdf iterations absurd', { kdf_params: { alg: 'PBKDF2-SHA256', iterations: 1e15 } }],
    ['kdf iterations fractional', { kdf_params: { alg: 'PBKDF2-SHA256', iterations: 600_000.5 } }],
    ['kdf params missing', { kdf_params: undefined }],
    ['wrapped_vk is not a string', { wrapped_vk: 42 }],
    ['wrapped_vk has no separator', { wrapped_vk: 'garbage' }],
    ['wrapped_vk IV is the wrong size', { wrapped_vk: 'AQID.AQID' }],
  ];
  for (const [label, patch] of hostile) {
    // isEnvelopeShapeError (not just "some rejection") is the assertion: a
    // wrong-length salt that fell through to the KDF would end in a plain
    // GCM failure instead, and a non-string wrapped_vk would surface as an
    // unrelated parse error.
    await rejectsQuickly(label, unlockVaultWithPassword(PASSWORD, { ...envelope, ...patch }), isEnvelopeShapeError);
  }
  // The recovery path validates the same way.
  await rejectsQuickly(
    'recovery_blob malformed',
    unlockVaultWithRecovery(PHRASE, { ...envelope, recovery_blob: 'x.y' }),
    isEnvelopeShapeError,
  );
  await rejectsQuickly(
    'recovery_salt wrong length',
    unlockVaultWithRecovery(PHRASE, { ...envelope, recovery_salt: encodeB64(new Uint8Array(17)) }),
    isEnvelopeShapeError,
  );
  // Sanity: the untouched fixture still opens after all that poking.
  assert.equal((await unlockVaultWithPassword(PASSWORD, envelope)).length, 32);
});

test('every region of a stored envelope is authenticated', async () => {
  const { envelope } = await createVaultEnvelope(PASSWORD, PHRASE);
  const parsed = decodeWrapped(envelope.wrapped_vk);
  assert.ok(parsed);
  const flip = (bytes: Uint8Array, index: number): Uint8Array => {
    const copy = Uint8Array.from(bytes);
    copy[index] ^= 0xff;
    return copy;
  };
  const tampered: Array<[string, string]> = [
    ['IV first byte', encodeWrapped(flip(parsed.iv, 0), parsed.ciphertext)],
    ['IV last byte', encodeWrapped(flip(parsed.iv, parsed.iv.length - 1), parsed.ciphertext)],
    ['ciphertext first byte', encodeWrapped(parsed.iv, flip(parsed.ciphertext, 0))],
    [
      'ciphertext middle byte',
      encodeWrapped(parsed.iv, flip(parsed.ciphertext, Math.floor(parsed.ciphertext.length / 2))),
    ],
    ['GCM tag (last byte)', encodeWrapped(parsed.iv, flip(parsed.ciphertext, parsed.ciphertext.length - 1))],
  ];
  for (const [label, wrapped] of tampered) {
    await expectReject(unlockVaultWithPassword(PASSWORD, { ...envelope, wrapped_vk: wrapped }), label);
  }

  // Salt and iteration count are KDF inputs: change either and the KEK
  // changes, so the unwrap fails even though every stored byte is intact.
  const salt = decodeB64(envelope.salt);
  salt[0] ^= 0xff;
  await expectReject(unlockVaultWithPassword(PASSWORD, { ...envelope, salt: encodeB64(salt) }), 'flipped salt byte');
  await expectReject(
    unlockVaultWithPassword(PASSWORD, {
      ...envelope,
      kdf_params: { alg: 'PBKDF2-SHA256', iterations: VAULT_KDF_ITERATIONS + 1 },
    }),
    'changed iteration count',
  );
});

test('envelope columns cannot be swapped or mixed across rows', async () => {
  const a = await createVaultEnvelope(PASSWORD, PHRASE);
  const b = await createVaultEnvelope(PASSWORD, PHRASE);

  // Within-row column swaps: each column is bound to its own role AND its own
  // salt, so no permutation of a single row opens.
  await expectReject(
    unlockVaultWithPassword(PASSWORD, { ...a.envelope, wrapped_vk: a.envelope.recovery_blob }),
    'recovery blob pasted into the password column',
  );
  await expectReject(
    unlockVaultWithRecovery(PHRASE, { ...a.envelope, recovery_blob: a.envelope.wrapped_vk }),
    'password blob pasted into the recovery column',
  );
  await expectReject(
    unlockVaultWithPassword(PASSWORD, { ...a.envelope, salt: a.envelope.recovery_salt }),
    'salt columns swapped (password)',
  );
  await expectReject(
    unlockVaultWithRecovery(PHRASE, { ...a.envelope, recovery_salt: a.envelope.salt }),
    'salt columns swapped (recovery)',
  );

  // Across-row mixing: blob from one row, salt from another.
  await expectReject(unlockVaultWithPassword(PASSWORD, { ...a.envelope, salt: b.envelope.salt }), 'foreign salt');

  // Both original rows still open — the failures above are binding failures,
  // not a broken fixture.
  assert.ok(equalBytes(await unlockVaultWithPassword(PASSWORD, a.envelope), a.vk));
  assert.ok(equalBytes(await unlockVaultWithRecovery(PHRASE, b.envelope), b.vk));
});

test('a corrupted recovery column leaves the password path intact', async () => {
  const { envelope, vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const damaged = { ...envelope, recovery_blob: 'x.y' };
  await assert.rejects(unlockVaultWithRecovery(PHRASE, damaged), isEnvelopeShapeError, 'recovery path must fail');
  assert.ok(
    equalBytes(await unlockVaultWithPassword(PASSWORD, damaged), vk),
    'the password path must ignore the recovery column entirely',
  );
});

// ─── Abnormal payloads, keys, and ids ───────────────────────────────────────

test('payloads of zero bytes and 256 KiB round-trip', async () => {
  const { vk } = await createVaultEnvelope(PASSWORD, PHRASE);

  const empty = await encryptVaultItem(vk, ITEM_ID, new Uint8Array(0));
  assert.ok(isValidWrappedKey(empty.payload), 'a tag-only ciphertext is still canonical wire form');
  assert.equal((await decryptVaultItem(vk, ITEM_ID, empty.item_key_wrapped, empty.payload)).length, 0);

  // 256 KiB, filled deterministically — getRandomValues caps per-call at 64 KiB.
  const big = new Uint8Array(256 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const bigItem = await encryptVaultItem(vk, ITEM_ID, big);
  const out = await decryptVaultItem(vk, ITEM_ID, bigItem.item_key_wrapped, bigItem.payload);
  assert.ok(equalBytes(out, big), 'large payload must survive both layers byte-for-byte');
});

test('only a 32-byte value can pass as VK', async () => {
  // Envelope level: a well-formed blob that unwraps to the wrong size must be
  // rejected right after the unwrap — never adopted as the session key.
  const kek = await deriveVaultKe(PASSWORD, salt00to0f());
  const shell = { salt: encodeB64(salt00to0f()), kdf_params: DEFAULT_VAULT_KDF_PARAMS };
  for (const length of [0, 31, 33]) {
    const wrapped = await wrapSecret(kek, new Uint8Array(length), CONTEXT_VK_PASSWORD);
    await assert.rejects(
      unlockVaultWithPassword(PASSWORD, { ...shell, wrapped_vk: wrapped }),
      isEnvelopeShapeError,
      `a ${length}-byte unwrap must not be accepted as VK`,
    );
  }
  // Item level: vaultKeyAsAesKey is the last line of defence.
  await assert.rejects(encryptVaultItem(new Uint8Array(31), ITEM_ID, new Uint8Array(4)), /32 bytes/);
  await assert.rejects(encryptVaultItem(new Uint8Array(33), ITEM_ID, new Uint8Array(4)), /32 bytes/);
});

test('item keys and payloads cannot be crossed between rows', async () => {
  const { vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const otherId = 'item_otherXYZ987';
  const one = await encryptVaultItem(vk, ITEM_ID, new TextEncoder().encode('first'));
  const two = await encryptVaultItem(vk, otherId, new TextEncoder().encode('second'));

  // Row-two key presented under row-one's id → layer-1 AAD mismatch.
  await expectReject(decryptVaultItem(vk, ITEM_ID, two.item_key_wrapped, one.payload), 'crossed item key');
  // Row-two key + row-one payload under row-two's id → layer 1 opens, layer 2
  // AAD mismatch. This pins BOTH layers, not just the outer one.
  await expectReject(decryptVaultItem(vk, otherId, two.item_key_wrapped, one.payload), 'crossed payload');

  // Sanity: the correct pairings still work.
  assert.equal(
    new TextDecoder().decode(await decryptVaultItem(vk, otherId, two.item_key_wrapped, two.payload)),
    'second',
  );
});

test('a foreign vault key cannot re-wrap an item key', async () => {
  const { vk } = await createVaultEnvelope(PASSWORD, PHRASE);
  const other = await createVaultEnvelope(PASSWORD, PHRASE);
  const item = await encryptVaultItem(vk, ITEM_ID, new TextEncoder().encode('body'));

  await expectReject(
    rewrapItemKeyForVaultKey(other.vk, vk, ITEM_ID, item.item_key_wrapped),
    're-wrap attempted with a foreign old VK',
  );
  await expectReject(rewrapItemKeyForVaultKey(vk, other.vk, ITEM_ID, 'not-a-blob'), 'malformed item key blob');
});

// ─── Recovery phrase boundaries and normalisation ───────────────────────────

test('recovery phrase word counts are exactly the BIP-39 lengths', async () => {
  const words = PHRASE.split(' ');
  const at = (n: number): string => Array.from({ length: n }, (_, i) => words[i % words.length]).join(' ');
  for (const n of [12, 15, 18, 21, 24]) assert.ok(isValidRecoveryPhrase(at(n)), `${n} words are valid`);
  for (const n of [11, 13, 23, 25]) assert.ok(!isValidRecoveryPhrase(at(n)), `${n} words are not a BIP-39 length`);

  // The failure message must name the real lengths — a "12-24" hint would
  // send users hunting for a 13-word phrase that can never exist.
  const phraseError = /12, 15, 18, 21, or 24/;
  await assert.rejects(createVaultEnvelope(PASSWORD, at(13)), phraseError);
  await assert.rejects(createVaultEnvelope(PASSWORD, at(25)), phraseError);
  await assert.rejects(rewrapVaultKeyForRecovery(generateVaultKeyBytes(), at(13), generateVaultSalt()), phraseError);

  // A valid 24-word phrase really derives and opens.
  const { envelope, vk } = await createVaultEnvelope(PASSWORD, at(24));
  assert.ok(equalBytes(await unlockVaultWithRecovery(at(24), envelope), vk));
});

test('phrases normalise to NFKD, so NFC and NFD typing derive the same REK', async () => {
  const nfc = PHRASE.replace('yellow', 'caf\u00e9'); // precomposed é (U+00E9)
  const nfd = PHRASE.replace('yellow', 'cafe\u0301'); // e + combining acute (U+0301)
  assert.notEqual(nfc, nfd, 'the two encodings must differ as typed');
  assert.equal(normalizeRecoveryPhrase(nfc), normalizeRecoveryPhrase(nfd));

  const { envelope, vk } = await createVaultEnvelope(PASSWORD, nfd);
  assert.ok(
    equalBytes(await unlockVaultWithRecovery(nfc, envelope), vk),
    'NFC typing must open an NFD-derived envelope',
  );

  // Full-width ideographic space (U+3000) counts as whitespace too.
  const ideographic = PHRASE.replace(/ /g, '　');
  assert.equal(normalizeRecoveryPhrase(ideographic), PHRASE);
  assert.ok(isValidRecoveryPhrase(ideographic));
});

test('vault item ids are validated at their boundaries', () => {
  assert.ok(isValidVaultItemId('a'.repeat(10)), '10 chars (minimum)');
  assert.ok(isValidVaultItemId('a'.repeat(40)), '40 chars (maximum)');
  assert.ok(!isValidVaultItemId('a'.repeat(9)), '9 chars');
  assert.ok(!isValidVaultItemId('a'.repeat(41)), '41 chars');
  assert.ok(!isValidVaultItemId(''), 'empty');
  // In range, but outside the charset: `:` would let a caller forge a context
  // prefix (`payload:a:REALID`) and `.` collides with the wrapped separator.
  assert.ok(!isValidVaultItemId('abc:defghij'), 'colon is not in the charset');
  assert.ok(!isValidVaultItemId('abc.defghij'), 'dot is not in the charset');
});

// ─── AAD context matrix ─────────────────────────────────────────────────────

test('AAD context strings are pinned — changing them strands every stored value', () => {
  assert.equal(CONTEXT_VK_PASSWORD, 'flaxia.vault.vk.v1');
  assert.equal(CONTEXT_VK_RECOVERY, 'flaxia.vault.vk.recovery.v1');
  assert.equal(CONTEXT_VK_DEVICE, 'flaxia.vault.vk.device.v1');
  assert.equal(CONTEXT_ITEM_KEY, 'flaxia.vault.itemkey.v1');
  assert.equal(CONTEXT_PAYLOAD, 'flaxia.vault.payload.v1');
});

test('all five AAD contexts are pairwise distinct', async () => {
  // One key for everything, so ONLY the AAD can be what separates the
  // contexts — 5 self-opens plus 5 × 4 = 20 cross pairs that must all fail.
  const kek = await deriveVaultKe(PASSWORD, salt00to0f());
  const value = new Uint8Array(32).fill(5);
  const contexts = [
    CONTEXT_VK_PASSWORD,
    CONTEXT_VK_RECOVERY,
    CONTEXT_VK_DEVICE,
    `${CONTEXT_ITEM_KEY}:${ITEM_ID}`,
    `${CONTEXT_PAYLOAD}:${ITEM_ID}`,
  ];
  const wrapped: string[] = [];
  for (const context of contexts) wrapped.push(await wrapSecret(kek, value, context));

  let crossPairs = 0;
  for (let i = 0; i < contexts.length; i++) {
    assert.ok(equalBytes(await unwrapSecret(kek, wrapped[i], contexts[i]), value), `context ${i} opens its own blob`);
    for (let j = 0; j < contexts.length; j++) {
      if (i === j) continue;
      crossPairs++;
      await expectReject(unwrapSecret(kek, wrapped[j], contexts[i]), `context ${i} must not open blob ${j}`);
    }
  }
  assert.equal(crossPairs, 20, '5 contexts × 4 foreign blobs each');
});

// ─── Encoding round-trips ───────────────────────────────────────────────────

test('base64 round-trips every byte value', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  assert.deepEqual(decodeB64(encodeB64(all)), all);
  assert.ok(isValidB64(encodeB64(all), 256));
});

test('decodeWrapped never throws on non-string input', () => {
  for (const value of [42, null, undefined, {}, [], true]) {
    assert.equal(decodeWrapped(value as unknown as string), null, `decodeWrapped(${String(value)}) must be null`);
  }
});

function generateVaultKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
