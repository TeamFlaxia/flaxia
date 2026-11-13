// Client-side mail crypto (docs/mail.md §6.2).
//
// Mirrors mail-worker/src/crypto.ts exactly — byte-compatibility is covered by
// mail-ecies.test.ts known-answer vectors. WebCrypto only; no ad-hoc
// constructions.

const subtle = (globalThis.crypto as Crypto).subtle;

export function wrapInfo(messageId: string, recipientAddress: string): string {
  return `flaxia.mail.wrap.v1:${messageId}:${recipientAddress}`;
}

export function attachmentKeyInfo(attachmentId: string): string {
  return `flaxia.mail.attachment.v1:${attachmentId}`;
}

export function metaInfo(messageId: string): string {
  return `flaxia.mail.meta.v1:${messageId}`;
}

export function subjectInfo(messageId: string): string {
  return `flaxia.mail.subject.v1:${messageId}`;
}

export function fromNameInfo(messageId: string): string {
  return `flaxia.mail.from-name.v1:${messageId}`;
}

export function attachmentNameInfo(attachmentId: string): string {
  return `flaxia.mail.attachment-name.v1:${attachmentId}`;
}

export function payloadInfo(messageId: string): string {
  return `flaxia.mail.payload.v1:${messageId}`;
}

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

export interface WrappedContentKey {
  ephemeralPublicKey: string;
  iv: string;
  wrappedContentKey: string;
}

async function importSpki(spkiB64: string): Promise<CryptoKey> {
  return (await subtle.importKey(
    'spki',
    decodeB64(spkiB64) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )) as CryptoKey;
}

async function importPkcs8(pkcs8B64: string): Promise<CryptoKey> {
  return (await subtle.importKey(
    'pkcs8',
    decodeB64(pkcs8B64) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )) as CryptoKey;
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

/** Wrap a 32-byte content key for one recipient (client ECIES). */
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
    ephemeralPublicKey: encodeB64(ephSpki),
    iv: encodeB64(iv),
    wrappedContentKey: encodeB64(new Uint8Array(ciphertext)),
  };
}

/** Unwrap a content key with the recipient's private key. */
export async function unwrapContentKey(
  wrapped: WrappedContentKey,
  recipientPkcs8B64: string,
  messageId: string,
  recipientAddress: string,
): Promise<Uint8Array> {
  const privateKey = await importPkcs8(recipientPkcs8B64);
  const ephemeralPublic = await importSpki(wrapped.ephemeralPublicKey);
  const wrapKey = await deriveWrapKey(privateKey, ephemeralPublic, wrapInfo(messageId, recipientAddress));
  const aad = new TextEncoder().encode(wrapInfo(messageId, recipientAddress));
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: decodeB64(wrapped.iv) as BufferSource, additionalData: aad },
    wrapKey,
    decodeB64(wrapped.wrappedContentKey) as BufferSource,
  );
  return new Uint8Array(plaintext);
}

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
  return { iv: encodeB64(iv), ciphertext: new Uint8Array(ciphertext) };
}

/** Encrypt bytes with AES-256-GCM and an explicit AAD (mirror of the Worker). */
export async function encryptBytes(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): Promise<{ iv: string; ciphertext: Uint8Array }> {
  const key = await subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(aad) },
    key,
    plaintext as BufferSource,
  );
  return { iv: encodeB64(iv), ciphertext: new Uint8Array(ciphertext) };
}

/** Encrypt a UTF-8 string; returns an `iv.ciphertext` envelope. */
export async function encryptString(keyBytes: Uint8Array, plaintext: string, info: string): Promise<string> {
  const encrypted = await encryptBytes(keyBytes, new TextEncoder().encode(plaintext), info);
  return `${encrypted.iv}.${encodeB64(encrypted.ciphertext)}`;
}

export async function decryptPayload(
  contentKey: Uint8Array,
  ivB64: string,
  ciphertext: Uint8Array,
  messageId: string,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', contentKey as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const aad = new TextEncoder().encode(`flaxia.mail.payload.v1:${messageId}`);
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: decodeB64(ivB64) as BufferSource, additionalData: aad },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}

/** Decrypt bytes sealed with AES-256-GCM + explicit AAD. */
export async function decryptBytes(
  keyBytes: Uint8Array,
  ivB64: string,
  ciphertext: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: decodeB64(ivB64) as BufferSource, additionalData: new TextEncoder().encode(aad) },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}

/** Decrypt an `iv.ciphertext` envelope produced by the Mail Worker. */
export async function decryptString(keyBytes: Uint8Array, envelope: string, info: string): Promise<string> {
  const [iv, ciphertext] = envelope.split('.', 2);
  if (!iv || !ciphertext) throw new Error('invalid encrypted string');
  const plaintext = await decryptBytes(keyBytes, iv, decodeB64(ciphertext), info);
  return new TextDecoder().decode(plaintext);
}

/** Seal attachment bytes with the per-attachment key derived from the content key. */
export async function encryptAttachment(
  contentKey: Uint8Array,
  attachmentId: string,
  plaintext: Uint8Array,
): Promise<{ iv: string; ciphertext: Uint8Array }> {
  const key = await deriveAttachmentKey(contentKey, attachmentId);
  try {
    return await encryptBytes(key, plaintext, attachmentKeyInfo(attachmentId));
  } finally {
    key.fill(0);
  }
}

/** Decrypt an attachment with the key derived from the message content key. */
export async function decryptAttachment(
  contentKey: Uint8Array,
  attachmentId: string,
  ivB64: string,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveAttachmentKey(contentKey, attachmentId);
  return decryptBytes(key, ivB64, ciphertext, attachmentKeyInfo(attachmentId));
}
