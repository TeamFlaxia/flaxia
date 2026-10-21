// QR pairing cryptography (docs/e2ee.md).
//
// The interesting assertions here are the ones a round-trip cannot make: both
// sides of a broken implementation happily open each other's output. So the
// suite pins the primitives with known-answer vectors and re-implements the
// unwrap independently from the exported pieces plus the IV parsed out of the
// blob — if production derived the wrong key, the independent decrypt fails.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPairingUri,
  derivePairingKeyMaterial,
  generateEphemeralKeyPair,
  isValidPairingId,
  pairingSharedSecret,
  parsePairingUri,
  unwrapVaultKeyForPairing,
  wrapVaultKeyForPairing,
} from '../src/lib/vault/pairing.ts';
import { decodeB64, encodeB64 } from '../src/lib/vault/primitives.ts';

const PAIRING_ID = 'pairingIdVector000001';
const RFC_SCALAR = 'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4';
const RFC_U_COORD = 'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c';
const RFC_OUTPUT = 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function freshVk(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function expectReject(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(promise, /unable to decrypt|invalid pairing|malformed/, `${label} should have failed`);
}

// ─── Known-answer vectors ────────────────────────────────────────────────────

test('X25519 matches RFC 7748', () => {
  assert.equal(
    encodeB64(pairingSharedSecret(hexToBytes(RFC_SCALAR), hexToBytes(RFC_U_COORD))),
    encodeB64(hexToBytes(RFC_OUTPUT)),
    'X25519 shared secret changed — pairing would open with the wrong key',
  );
});

test('HKDF key material matches the pinned vector', () => {
  const okm = derivePairingKeyMaterial(hexToBytes(RFC_OUTPUT), PAIRING_ID);
  assert.equal(
    encodeB64(okm),
    'UHZV9xmWX/bc0gaOm0aMwE8stuRw7YlwIWqSpZEJmz8=',
    'pairing KDF changed — every outstanding QR would stop opening',
  );
  assert.ok(
    okm.some((x) => x !== 0),
    'key material must not be all zeros (a zeroed buffer would still round-trip)',
  );
});

test('the pairing id is part of the key derivation', () => {
  const shared = hexToBytes(RFC_OUTPUT);
  const a = encodeB64(derivePairingKeyMaterial(shared, PAIRING_ID));
  const b = encodeB64(derivePairingKeyMaterial(shared, `${PAIRING_ID}x`));
  assert.notEqual(a, b, 'two pairings must never share a key');
});

// ─── Handshake ───────────────────────────────────────────────────────────────

test('both sides derive the same key from their own secret and the peer public key', () => {
  const a = generateEphemeralKeyPair();
  const b = generateEphemeralKeyPair();
  assert.equal(a.secretKey.length, 32);
  assert.equal(a.publicKey.length, 32);
  assert.notEqual(encodeB64(a.publicKey), encodeB64(b.publicKey));

  assert.ok(
    equalBytes(pairingSharedSecret(a.secretKey, b.publicKey), pairingSharedSecret(b.secretKey, a.publicKey)),
    'ECDH must be symmetric or the two devices derive different keys',
  );
});

test('a wrapped vault key crosses from approver to joiner', async () => {
  const approver = generateEphemeralKeyPair();
  const joiner = generateEphemeralKeyPair();
  const vk = freshVk();

  const blob = await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, PAIRING_ID);
  const opened = await unwrapVaultKeyForPairing(blob, joiner.secretKey, approver.publicKey, PAIRING_ID);
  assert.ok(equalBytes(opened, vk));
});

test('an independent implementation opens the blob (guards against a zeroed key)', async () => {
  const approver = generateEphemeralKeyPair();
  const joiner = generateEphemeralKeyPair();
  const vk = freshVk();

  const blob = await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, PAIRING_ID);
  const [ivPart, ctPart] = blob.split('.');
  assert.ok(ivPart && ctPart, 'blob must be base64(iv).base64(ct)');

  const okm = derivePairingKeyMaterial(pairingSharedSecret(joiner.secretKey, approver.publicKey), PAIRING_ID);
  const key = await crypto.subtle.importKey('raw', okm as BufferSource, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decodeB64(ivPart) as BufferSource,
      additionalData: new TextEncoder().encode(`flaxia.vault.pair.v1:${PAIRING_ID}`),
    },
    key,
    decodeB64(ctPart) as BufferSource,
  );
  assert.ok(equalBytes(new Uint8Array(plaintext), vk));
});

test('the wrong secret, the wrong peer, and the wrong pairing id all fail', async () => {
  const approver = generateEphemeralKeyPair();
  const joiner = generateEphemeralKeyPair();
  const stranger = generateEphemeralKeyPair();
  const vk = freshVk();

  const blob = await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, PAIRING_ID);

  await expectReject(
    unwrapVaultKeyForPairing(blob, stranger.secretKey, approver.publicKey, PAIRING_ID),
    'someone else joins',
  );
  await expectReject(
    unwrapVaultKeyForPairing(blob, joiner.secretKey, stranger.publicKey, PAIRING_ID),
    'approver replaced by a stranger',
  );
  await expectReject(
    unwrapVaultKeyForPairing(blob, joiner.secretKey, approver.publicKey, `${PAIRING_ID}x`),
    'blob replayed into another pairing',
  );
});

test('a tampered blob fails authentication', async () => {
  const approver = generateEphemeralKeyPair();
  const joiner = generateEphemeralKeyPair();
  const blob = await wrapVaultKeyForPairing(freshVk(), approver.secretKey, joiner.publicKey, PAIRING_ID);

  const [ivPart, ctPart] = blob.split('.');
  const bytes = decodeB64(ctPart);
  bytes[bytes.length - 1] ^= 0xff;
  await expectReject(
    unwrapVaultKeyForPairing(`${ivPart}.${encodeB64(bytes)}`, joiner.secretKey, approver.publicKey, PAIRING_ID),
    'bit flip in the ciphertext',
  );
});

test('two wraps of the same key differ (fresh IV every time)', async () => {
  const approver = generateEphemeralKeyPair();
  const joiner = generateEphemeralKeyPair();
  const vk = freshVk();
  const a = await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, PAIRING_ID);
  const b = await wrapVaultKeyForPairing(vk, approver.secretKey, joiner.publicKey, PAIRING_ID);
  assert.notEqual(a, b, 'a repeated IV would make the pairing blob deterministic');
});

// ─── QR payload ──────────────────────────────────────────────────────────────

test('the pairing URI round-trips', () => {
  const joiner = generateEphemeralKeyPair();
  const uri = buildPairingUri(PAIRING_ID, joiner.publicKey);
  assert.ok(uri.startsWith('flaxia-vault://pair/'));

  const parsed = parsePairingUri(uri);
  assert.ok(parsed);
  assert.equal(parsed.pairingId, PAIRING_ID);
  assert.ok(equalBytes(parsed.publicKey, joiner.publicKey));
});

test('the pairing URI carries no secret material', () => {
  const joiner = generateEphemeralKeyPair();
  const uri = buildPairingUri(PAIRING_ID, joiner.publicKey);
  assert.ok(!uri.includes(encodeB64(joiner.secretKey)), 'the private key must never reach the QR');
  // The QR shows only the id and the public half.
  assert.equal(uri.split('#')[1], encodeB64(joiner.publicKey));
});

test('scanned junk is rejected rather than half-parsed', () => {
  const joiner = generateEphemeralKeyPair();
  const pub = encodeB64(joiner.publicKey);
  assert.equal(parsePairingUri(`https://evil.example/pair/${PAIRING_ID}#${pub}`), null, 'foreign scheme');
  assert.equal(parsePairingUri(`flaxia-vault://pair/${PAIRING_ID}`), null, 'missing public key');
  assert.equal(parsePairingUri(`flaxia-vault://pair/short#${pub}`), null, 'id too short');
  assert.equal(parsePairingUri(`flaxia-vault://pair/${PAIRING_ID}#not-base64!!`), null, 'garbage key');
  assert.equal(
    parsePairingUri(`flaxia-vault://pair/${PAIRING_ID}#${encodeB64(new Uint8Array(16))}`),
    null,
    'short key',
  );
  assert.equal(parsePairingUri(''), null, 'empty');
});

test('pairing ids are validated consistently', () => {
  assert.ok(isValidPairingId(PAIRING_ID));
  assert.ok(isValidPairingId('a'.repeat(21)), 'nanoid-shaped ids pass');
  assert.ok(!isValidPairingId('short'), 'too short');
  assert.ok(!isValidPairingId('a'.repeat(41)), 'too long');
  assert.ok(!isValidPairingId('has spaces in it here!!'), 'charset');
  assert.ok(!isValidPairingId(null));
});
