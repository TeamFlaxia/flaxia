// Mail identity key management (docs/mail.md §6.2-6.3).
//
// One P-256 ECDH key pair per key version. The private key (PKCS#8) lives as a
// vault item of kind `mail_identity`, wrapped by VK; the public key (SPKI,
// base64) is published to `mail_identities` via /api/mail/keys/me. The server
// never sees VK or the unwrapped private key — it only stores the SPKI blob
// the client uploads.
//
// Unlock is lazy, following the PostComposer pattern: `ensureVaultUnlocked()`
// tries the device key first, then the caller falls back to the VaultSection
// password prompt. No global unlock gate is required.

import { listVaultItems, newVaultItemId, saveVaultItem } from './items.ts';
import { decodeB64, encodeB64 } from './primitives.ts';
import { getVaultKey, isVaultUnlocked, tryDeviceUnlock } from './session.ts';

export interface MailIdentityMaterial {
  keyVersion: number;
  /** P-256 SPKI base64 — the value published to mail_identities. */
  publicKeySpkiB64: string;
  /** PKCS#8 base64 — the vault item payload. */
  privateKeyPkcs8B64: string;
}

const subtle = (globalThis.crypto as Crypto).subtle;

export async function generateMailIdentity(keyVersion = 1): Promise<MailIdentityMaterial> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  return {
    keyVersion,
    publicKeySpkiB64: encodeB64(spki),
    privateKeyPkcs8B64: encodeB64(pkcs8),
  };
}

export async function importMailIdentityPrivateKey(pkcs8B64: string): Promise<CryptoKey> {
  return (await subtle.importKey(
    'pkcs8',
    decodeB64(pkcs8B64) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )) as CryptoKey;
}

export async function importMailIdentityPublicKey(spkiB64: string): Promise<CryptoKey> {
  return (await subtle.importKey(
    'spki',
    decodeB64(spkiB64) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )) as CryptoKey;
}

/** Lazily unlock the vault (device key first). Returns true if VK is in memory. */
export async function ensureVaultUnlocked(): Promise<boolean> {
  if (isVaultUnlocked()) return true;
  if (await tryDeviceUnlock()) return true;
  return isVaultUnlocked();
}

/**
 * Generate (or load) the mail identity for one key version and persist the
 * private key as a vault item. The item id encodes the version so rotation
 * keeps old private keys readable (docs/mail.md §6.3 step 4).
 */
export async function provisionMailIdentity(keyVersion = 1): Promise<MailIdentityMaterial> {
  if (!getVaultKey()) throw new Error('mail_vault_required: unlock the Personal Vault first');

  // Reuse an existing identity so a failed activation (for example, the Worker
  // is not deployed yet) does not create a new orphan vault item on every
  // retry. Rotation is a future explicit operation, not a side effect here.
  const existing = await loadMailIdentity();
  if (existing) return existing;

  const material = await generateMailIdentity(keyVersion);
  const itemId = `mail-v${keyVersion}-${newVaultItemId()}`.slice(0, 40);
  await saveVaultItem(itemId, 'mail_identity', {
    keyVersion,
    publicKeySpkiB64: material.publicKeySpkiB64,
    privateKeyPkcs8B64: material.privateKeyPkcs8B64,
  });
  return material;
}

interface StoredMailIdentity {
  keyVersion: number;
  publicKeySpkiB64: string;
  privateKeyPkcs8B64: string;
}

/** Load the newest stored mail identity private key, if any. */
export async function loadMailIdentity(): Promise<MailIdentityMaterial | null> {
  if (!getVaultKey()) return null;
  const items = await listVaultItems<StoredMailIdentity>('mail_identity');
  if (items.length === 0) return null;
  const sorted = items.sort((a, b) => (b.value.keyVersion ?? 0) - (a.value.keyVersion ?? 0));
  const newest = sorted[0].value;
  return {
    keyVersion: newest.keyVersion,
    publicKeySpkiB64: newest.publicKeySpkiB64,
    privateKeyPkcs8B64: newest.privateKeyPkcs8B64,
  };
}
