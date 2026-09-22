// QR device pairing (docs/e2ee.md).
//
// The joiner (device B) generates an *ephemeral* X25519 keypair and prints its
// public half into a QR code. The approver (device A, which already holds VK)
// scans it, derives a shared secret, and posts VK wrapped under that secret.
// Both private keys are discarded as soon as B opens the envelope, so nothing
// long-lived is ever stored: the row on the server holds a blob that only the
// two participants of this one pairing could ever read.
//
//   shared = X25519(B_priv, A_pub) = X25519(A_priv, B_pub)
//   KEK    = HKDF-SHA256(shared, salt, info = "flaxia.vault.pair.v1:<id>")
//   blob   = AES-256-GCM(KEK, VK, aad = "flaxia.vault.pair.v1:<id>")
//
// The pairing id is mixed into both the KDF info and the AAD, so a blob cannot
// be replayed into another pairing session even if an attacker with a session
// swaps rows.
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeB64, encodeB64, unwrapSecret, wrapSecret } from './primitives.ts';

export const PAIRING_URI_PREFIX = 'flaxia-vault://pair/';
/** Base64url of 16 random bytes = 22 chars; server ids are nanoid (21). */
export const PAIRING_ID_PATTERN = /^[A-Za-z0-9_-]{16,40}$/;
export const PAIRING_TTL_SECONDS = 600;

const CONTEXT_PAIRING = 'flaxia.vault.pair.v1';
const HKDF_SALT_INFO = 'flaxia.vault.pair.salt.v1';

export interface EphemeralKeyPair {
  /** Never persisted: it is discarded once the vault key has been opened. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface PairingRequest {
  pairingId: string;
  publicKey: Uint8Array;
}

export function isValidPairingId(value: unknown): value is string {
  return typeof value === 'string' && PAIRING_ID_PATTERN.test(value);
}

export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey };
}

function context(pairingId: string): string {
  if (!isValidPairingId(pairingId)) throw new Error('invalid pairing id');
  return `${CONTEXT_PAIRING}:${pairingId}`;
}

/**
 * Raw X25519 output for one pairing. Exported so tests can pin it against the
 * RFC 7748 vectors; nothing in the protocol needs the shared secret itself,
 * only what HKDF makes of it.
 */
export function pairingSharedSecret(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, peerPublicKey);
}

/** HKDF output for a shared secret + pairing id. Exported for known-answer tests. */
export function derivePairingKeyMaterial(shared: Uint8Array, pairingId: string): Uint8Array {
  const salt = sha256(new TextEncoder().encode(HKDF_SALT_INFO));
  return hkdf(sha256, shared, salt, new TextEncoder().encode(context(pairingId)), 32);
}

async function derivePairingKey(
  secretKey: Uint8Array,
  peerPublicKey: Uint8Array,
  pairingId: string,
): Promise<CryptoKey> {
  if (peerPublicKey.length !== 32) throw new Error('invalid pairing public key');
  const shared = pairingSharedSecret(secretKey, peerPublicKey);
  const okm = derivePairingKeyMaterial(shared, pairingId);
  shared.fill(0);
  // importKey copies its input, so zeroing afterwards is both safe and
  // required: derived key material must not outlive this call. Getting this
  // order wrong silently encrypts with an all-zero key while still round-tripping.
  const key = await crypto.subtle.importKey('raw', okm as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  okm.fill(0);
  return key;
}

/** Approver side: wrap VK for whoever holds the private key behind `peerPublicKey`. */
export async function wrapVaultKeyForPairing(
  vk: Uint8Array,
  secretKey: Uint8Array,
  peerPublicKey: Uint8Array,
  pairingId: string,
): Promise<string> {
  const key = await derivePairingKey(secretKey, peerPublicKey, pairingId);
  return wrapSecret(key, vk, context(pairingId));
}

/** Joiner side: open the approver's blob with its own discarded-later secret. */
export async function unwrapVaultKeyForPairing(
  wrappedVk: string,
  secretKey: Uint8Array,
  peerPublicKey: Uint8Array,
  pairingId: string,
): Promise<Uint8Array> {
  const key = await derivePairingKey(secretKey, peerPublicKey, pairingId);
  return unwrapSecret(key, wrappedVk, context(pairingId));
}

/**
 * What the joiner displays as a QR code. The fragment carries the public key
 * only — no secret material ever appears on screen or in the URL.
 */
export function buildPairingUri(pairingId: string, publicKey: Uint8Array): string {
  if (!isValidPairingId(pairingId)) throw new Error('invalid pairing id');
  if (publicKey.length !== 32) throw new Error('invalid pairing public key');
  return `${PAIRING_URI_PREFIX}${pairingId}#${encodeB64(publicKey)}`;
}

/** Parses what the approver's scanner saw. Rejects anything that is not ours. */
export function parsePairingUri(value: string): PairingRequest | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(PAIRING_URI_PREFIX)) return null;
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex < 0) return null;

  const pairingId = trimmed.slice(PAIRING_URI_PREFIX.length, hashIndex);
  if (!isValidPairingId(pairingId)) return null;

  let publicKey: Uint8Array;
  try {
    publicKey = decodeB64(trimmed.slice(hashIndex + 1));
  } catch {
    return null;
  }
  if (publicKey.length !== 32) return null;
  return { pairingId, publicKey };
}
