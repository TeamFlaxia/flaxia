/// <reference types="@cloudflare/workers-types" />
// Server-side ECIES content-key wrapping (docs/mail.md §6.2).
//
// The Worker wraps the per-message content key for the recipient's current
// P-256 SPKI public key at ingest time. It never sees the recipient's
// private key, VK, or any client plaintext beyond the ingest window.
//
// Wrapping: ephemeral P-256 ECDH + HKDF-SHA256 with
//   info = "flaxia.mail.wrap.v1:<message_id>:<recipient_address>"
// then AES-256-GCM. The AAD binds the wrap to message + recipient so a
// wrapped key cannot be moved to another row.
//
// Byte-compatibility with the client (src/lib/mail/crypto.ts) is covered by
// mail-ecies.test.ts known-answer vectors.

const subtle = (globalThis.crypto as Crypto).subtle;

export function wrapInfo(messageId: string, recipientAddress: string): string {
  return `flaxia.mail.wrap.v1:${messageId}:${recipientAddress}`;
}

export function attachmentKeyInfo(attachmentId: string): string {
  return `flaxia.mail.attachment.v1:${attachmentId}`;
}

export function b64encode(bytes: Uint8Array): string {
  let binary = '';
  for (const x of bytes) binary += String.fromCharCode(x);
  return btoa(binary);
}

export function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value) as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function importSpki(spkiB64: string): Promise<CryptoKey> {
  return (await subtle.importKey(
    'spki',
    b64decode(spkiB64) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    // ECDH public keys must be imported with no usages (WebCrypto spec); the
    // private key supplies the usages in deriveBits/deriveKey.
    [],
  )) as CryptoKey;
}

/**
 * Validate a published identity key before storing it. An invalid or
 * non-P-256 SPKI would silently break every future inbound message for the
 * mailbox, so activation must fail closed.
 */
export async function isValidP256SpkiB64(value: unknown): Promise<boolean> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  try {
    const bytes = b64decode(value);
    if (bytes.length === 0 || bytes.length > 256) return false;
    await subtle.importKey('spki', bytes as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return true;
  } catch {
    return false;
  }
}

async function deriveWrapKey(
  ephemeralPrivate: CryptoKey,
  recipientPublic: CryptoKey,
  info: string,
): Promise<CryptoKey> {
  const shared = await subtle.deriveBits(
    { name: 'ECDH', public: recipientPublic as unknown as CryptoKey },
    ephemeralPrivate as unknown as CryptoKey,
    256,
  );
  const hkdfBase = await subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveKey']);
  return (await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(''), info: new TextEncoder().encode(info) },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )) as CryptoKey;
}

export interface WrappedContentKey {
  ephemeralPublicKey: string;
  iv: string;
  wrappedContentKey: string;
}

/** Wrap a 32-byte content key for one recipient. */
export async function wrapContentKey(
  contentKey: Uint8Array,
  recipientSpkiB64: string,
  messageId: string,
  recipientAddress: string,
): Promise<WrappedContentKey> {
  if (contentKey.length !== 32) throw new Error('content key must be 32 bytes');
  const ephemeral = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])) as CryptoKeyPair;
  const recipientPublic = await importSpki(recipientSpkiB64);
  const wrapKey = await deriveWrapKey(ephemeral.privateKey, recipientPublic, wrapInfo(messageId, recipientAddress));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(wrapInfo(messageId, recipientAddress));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad },
    wrapKey,
    contentKey as BufferSource,
  );
  const ephSpki = new Uint8Array(await subtle.exportKey('spki', ephemeral.publicKey));
  return {
    ephemeralPublicKey: b64encode(ephSpki),
    iv: b64encode(iv),
    wrappedContentKey: b64encode(new Uint8Array(ciphertext)),
  };
}

/** Derive the per-attachment key from the content key (HKDF). */
export async function deriveAttachmentKey(contentKey: Uint8Array, attachmentId: string): Promise<Uint8Array> {
  const hkdfBase = await subtle.importKey('raw', contentKey as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(''),
      info: new TextEncoder().encode(attachmentKeyInfo(attachmentId)),
    },
    hkdfBase,
    256,
  );
  return new Uint8Array(bits);
}

/** Encrypt a payload once with the content key. */
export async function encryptPayload(
  contentKey: Uint8Array,
  plaintext: Uint8Array,
  messageId: string,
): Promise<{ iv: string; ciphertext: Uint8Array }> {
  const key = await subtle.importKey('raw', contentKey as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`flaxia.mail.payload.v1:${messageId}`);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad },
    key,
    plaintext as BufferSource,
  );
  return { iv: b64encode(iv), ciphertext: new Uint8Array(ciphertext) };
}
