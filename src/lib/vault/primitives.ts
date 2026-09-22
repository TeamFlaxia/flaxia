// Vault cryptography primitives.
//
// Everything here runs in the browser: the server only ever stores the byte
// strings these functions produce (see docs/e2ee.md for the threat model and
// the full key hierarchy). Nothing in this module may be moved server-side,
// and no secret it derives may be sent to an endpoint.
//
//   password ──PBKDF2(600k, salt)────────► KEK ─┐
//   recovery phrase ──PBKDF2(600k, recovery_salt)──► REK ─┤─wrap─► VK
//   device key (non-extractable CryptoKey) ────────────────┘
//                                                          │
//                                                          └─wrap─► item_key[i]
//                                                                      │
//                                                                      └─AES-GCM─► payload[i]

const subtle = (globalThis.crypto as Crypto).subtle;

export const VAULT_FORMAT_VERSION = 1;
export const VAULT_KEY_BYTES = 32;
export const VAULT_SALT_BYTES = 16;
export const VAULT_IV_BYTES = 12;
export const VAULT_KDF_ITERATIONS = 600_000;

export interface VaultKdfParams {
  readonly alg: 'PBKDF2-SHA256';
  readonly iterations: number;
}

export const DEFAULT_VAULT_KDF_PARAMS: VaultKdfParams = {
  alg: 'PBKDF2-SHA256',
  iterations: VAULT_KDF_ITERATIONS,
};

// Every wrap operation binds the ciphertext to its role via AES-GCM AAD, so a
// value lifted out of one column cannot be pasted into another.
export const CONTEXT_VK_PASSWORD = 'flaxia.vault.vk.v1';
export const CONTEXT_VK_RECOVERY = 'flaxia.vault.vk.recovery.v1';
export const CONTEXT_VK_DEVICE = 'flaxia.vault.vk.device.v1';
export const CONTEXT_ITEM_KEY = 'flaxia.vault.itemkey.v1';
export const CONTEXT_PAYLOAD = 'flaxia.vault.payload.v1';

export function encodeB64(bytes: Uint8Array): string {
  let binary = '';
  for (const x of bytes) binary += String.fromCharCode(x);
  return btoa(binary);
}

export function decodeB64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Canonical wire form of a wrapped value: `base64(iv).base64(ciphertext)`.
export function encodeWrapped(iv: Uint8Array, ciphertext: Uint8Array): string {
  return `${encodeB64(iv)}.${encodeB64(ciphertext)}`;
}

export function decodeWrapped(value: string): { iv: Uint8Array; ciphertext: Uint8Array } | null {
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = decodeB64(parts[0]);
    ciphertext = decodeB64(parts[1]);
  } catch {
    return null;
  }
  // GCM tag is 16 bytes, so a ciphertext shorter than that cannot be valid.
  if (iv.length !== VAULT_IV_BYTES || ciphertext.length < 16) return null;
  return { iv, ciphertext };
}

function itemContext(base: string, itemId: string): string {
  return `${base}:${itemId}`;
}

export function generateVaultKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES));
}

export function generateVaultSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(VAULT_SALT_BYTES));
}

// Raw KDF output. Exported so tests can pin it with known-answer vectors: the
// KEK is exactly these 32 bytes imported as AES-GCM, so the vector covers the
// production path rather than a test-only duplicate.
export async function deriveVaultKeBits(
  secret: string,
  salt: Uint8Array,
  params: VaultKdfParams = DEFAULT_VAULT_KDF_PARAMS,
): Promise<Uint8Array> {
  const material = await subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: params.iterations, hash: 'SHA-256' },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export async function deriveVaultKe(
  secret: string,
  salt: Uint8Array,
  params: VaultKdfParams = DEFAULT_VAULT_KDF_PARAMS,
): Promise<CryptoKey> {
  const bits = await deriveVaultKeBits(secret, salt, params);
  return subtle.importKey('raw', bits as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function vaultKeyAsAesKey(vk: Uint8Array): Promise<CryptoKey> {
  if (vk.length !== VAULT_KEY_BYTES) throw new Error('vault key must be 32 bytes');
  return subtle.importKey('raw', vk as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptWith(key: CryptoKey, plaintext: Uint8Array, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES)) as Uint8Array<ArrayBuffer>;
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(context) },
    key,
    plaintext as BufferSource,
  );
  return encodeWrapped(iv, new Uint8Array(ciphertext));
}

async function decryptWith(key: CryptoKey, encoded: string, context: string): Promise<Uint8Array> {
  const parsed = decodeWrapped(encoded);
  if (!parsed) throw new Error('malformed wrapped value');
  try {
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: parsed.iv as BufferSource,
        additionalData: new TextEncoder().encode(context),
      },
      key,
      parsed.ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    // Wrong key, wrong context, or tampered bytes — indistinguishable on purpose.
    throw new Error('unable to decrypt vault value');
  }
}

// Wrap raw bytes under a password/phrase-derived key.
export async function wrapSecret(kek: CryptoKey, plaintext: Uint8Array, context: string): Promise<string> {
  return encryptWith(kek, plaintext, context);
}

export async function unwrapSecret(kek: CryptoKey, encoded: string, context: string): Promise<Uint8Array> {
  return decryptWith(kek, encoded, context);
}

// ─── Recovery phrase ─────────────────────────────────────────────────────────
// BIP-39 requires NFKD before key derivation, and whitespace must be canonical
// or the same typed phrase yields a different REK on another platform.
// Checksum validation happens alongside `@scure/bip39` (see docs/e2ee.md).

export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.normalize('NFKD').trim().split(/\s+/u).filter(Boolean).join(' ');
}

export function recoveryPhraseWordCount(phrase: string): number {
  return normalizeRecoveryPhrase(phrase).split(' ').filter(Boolean).length;
}

/** 12/15/18/21/24 words — the counts BIP-39 allows. Checksum is not checked here. */
export function isValidRecoveryPhrase(phrase: string): boolean {
  const count = recoveryPhraseWordCount(phrase);
  return count === 12 || count === 15 || count === 18 || count === 21 || count === 24;
}

// ─── Vault envelope ──────────────────────────────────────────────────────────

export interface VaultEnvelope {
  /** base64, 16 bytes — salts the password path. */
  salt: string;
  /** base64, 16 bytes — salts the recovery path, independently of the password. */
  recovery_salt: string;
  kdf_params: VaultKdfParams;
  /** VK wrapped under the password-derived KEK. */
  wrapped_vk: string;
  /** VK wrapped under the recovery-phrase-derived REK. */
  recovery_blob: string;
  vk_version: number;
}

/** Create the stored envelope. VK is returned in memory only — never persisted raw. */
export async function createVaultEnvelope(
  password: string,
  recoveryPhrase: string,
  params: VaultKdfParams = DEFAULT_VAULT_KDF_PARAMS,
): Promise<{ envelope: VaultEnvelope; vk: Uint8Array }> {
  const phrase = normalizeRecoveryPhrase(recoveryPhrase);
  if (!isValidRecoveryPhrase(phrase)) throw new Error('recovery phrase must be 12-24 words');

  const vk = generateVaultKey();
  const salt = generateVaultSalt();
  const recoverySalt = generateVaultSalt();

  const kek = await deriveVaultKe(password, salt, params);
  const rek = await deriveVaultKe(phrase, recoverySalt, params);

  return {
    envelope: {
      salt: encodeB64(salt),
      recovery_salt: encodeB64(recoverySalt),
      kdf_params: params,
      wrapped_vk: await wrapSecret(kek, vk, CONTEXT_VK_PASSWORD),
      recovery_blob: await wrapSecret(rek, vk, CONTEXT_VK_RECOVERY),
      vk_version: 1,
    },
    vk,
  };
}

export async function unlockVaultWithPassword(
  password: string,
  envelope: Pick<VaultEnvelope, 'salt' | 'kdf_params' | 'wrapped_vk'>,
): Promise<Uint8Array> {
  const kek = await deriveVaultKe(password, decodeB64(envelope.salt), envelope.kdf_params);
  return unwrapSecret(kek, envelope.wrapped_vk, CONTEXT_VK_PASSWORD);
}

export async function unlockVaultWithRecovery(
  recoveryPhrase: string,
  envelope: Pick<VaultEnvelope, 'recovery_salt' | 'kdf_params' | 'recovery_blob'>,
): Promise<Uint8Array> {
  const rek = await deriveVaultKe(
    normalizeRecoveryPhrase(recoveryPhrase),
    decodeB64(envelope.recovery_salt),
    envelope.kdf_params,
  );
  return unwrapSecret(rek, envelope.recovery_blob, CONTEXT_VK_RECOVERY);
}

/** Password change: re-wrap VK under the new KEK. Items and devices are untouched. */
export async function rewrapVaultKeyForPassword(
  vk: Uint8Array,
  newPassword: string,
  salt: Uint8Array,
  params: VaultKdfParams = DEFAULT_VAULT_KDF_PARAMS,
): Promise<string> {
  const kek = await deriveVaultKe(newPassword, salt, params);
  return wrapSecret(kek, vk, CONTEXT_VK_PASSWORD);
}

/** Recovery phrase change: re-wrap VK under the new REK. */
export async function rewrapVaultKeyForRecovery(
  vk: Uint8Array,
  newPhrase: string,
  recoverySalt: Uint8Array,
  params: VaultKdfParams = DEFAULT_VAULT_KDF_PARAMS,
): Promise<string> {
  const phrase = normalizeRecoveryPhrase(newPhrase);
  if (!isValidRecoveryPhrase(phrase)) throw new Error('recovery phrase must be 12-24 words');
  const rek = await deriveVaultKe(phrase, recoverySalt, params);
  return wrapSecret(rek, vk, CONTEXT_VK_RECOVERY);
}

// ─── Devices ─────────────────────────────────────────────────────────────────
// The device key is a non-extractable AES-GCM key: page script can ask it to
// unwrap VK but can never read it out of IndexedDB.

export function createDeviceKey(): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES)) as Uint8Array<ArrayBuffer>;
  return subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function wrapVaultKeyForDevice(vk: Uint8Array, deviceKey: CryptoKey): Promise<string> {
  return encryptWith(deviceKey, vk, CONTEXT_VK_DEVICE);
}

export function unwrapVaultKeyWithDevice(encoded: string, deviceKey: CryptoKey): Promise<Uint8Array> {
  return decryptWith(deviceKey, encoded, CONTEXT_VK_DEVICE);
}

// ─── Items ───────────────────────────────────────────────────────────────────

export interface VaultItemCiphertext {
  /** Client-generated id; it is also the AAD, so a payload cannot be moved to another row. */
  item_id: string;
  item_key_wrapped: string;
  payload: string;
}

export async function encryptVaultItem(
  vk: Uint8Array,
  itemId: string,
  plaintext: Uint8Array,
): Promise<VaultItemCiphertext> {
  const vkKey = await vaultKeyAsAesKey(vk);
  const itemKey = generateVaultKey();
  const itemKeyAes = await vaultKeyAsAesKey(itemKey);
  return {
    item_id: itemId,
    item_key_wrapped: await encryptWith(vkKey, itemKey, itemContext(CONTEXT_ITEM_KEY, itemId)),
    payload: await encryptWith(itemKeyAes, plaintext, itemContext(CONTEXT_PAYLOAD, itemId)),
  };
}

export async function decryptVaultItem(
  vk: Uint8Array,
  itemId: string,
  itemKeyWrapped: string,
  payload: string,
): Promise<Uint8Array> {
  const vkKey = await vaultKeyAsAesKey(vk);
  const itemKey = await unwrapSecret(vkKey, itemKeyWrapped, itemContext(CONTEXT_ITEM_KEY, itemId));
  const itemKeyAes = await vaultKeyAsAesKey(itemKey);
  return decryptWith(itemKeyAes, payload, itemContext(CONTEXT_PAYLOAD, itemId));
}

/**
 * Device revocation: VK is replaced, so every item key is re-wrapped under the
 * new VK. Payloads are never rewritten — they are already bound to their own
 * item key, which did not change.
 */
export async function rewrapItemKeyForVaultKey(
  oldVk: Uint8Array,
  newVk: Uint8Array,
  itemId: string,
  itemKeyWrapped: string,
): Promise<string> {
  const oldKey = await vaultKeyAsAesKey(oldVk);
  const newKey = await vaultKeyAsAesKey(newVk);
  const itemKey = await unwrapSecret(oldKey, itemKeyWrapped, itemContext(CONTEXT_ITEM_KEY, itemId));
  return encryptWith(newKey, itemKey, itemContext(CONTEXT_ITEM_KEY, itemId));
}

// ─── Server-side validation ──────────────────────────────────────────────────
// The API handlers use these so an endpoint can shape-check opaque values
// without ever being able to interpret them.

export function isValidVaultKdfParams(value: unknown): value is VaultKdfParams {
  if (typeof value !== 'object' || value === null) return false;
  const params = value as { alg?: unknown; iterations?: unknown };
  return params.alg === 'PBKDF2-SHA256' && typeof params.iterations === 'number' && params.iterations >= 100_000;
}

export function isValidB64(value: unknown, bytes?: number): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const decoded = decodeB64(value);
    return bytes === undefined ? decoded.length > 0 : decoded.length === bytes;
  } catch {
    return false;
  }
}

export function isValidWrappedKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return decodeWrapped(value) !== null;
}

const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{10,40}$/;

export function isValidVaultItemId(value: unknown): value is string {
  return typeof value === 'string' && ITEM_ID_PATTERN.test(value);
}
