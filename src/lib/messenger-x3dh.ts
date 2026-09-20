// X3DH key agreement (Signal-style) built on X25519 + Ed25519.
//
// A user publishes a prekey bundle:
//   - identity (sign) key:  Ed25519, used to sign the signed prekey
//   - identity (dh) key:    X25519, used in the X3DH DH steps
//   - signed prekey (SPK):  X25519, signed by the identity sign key
//   - one-time prekeys:     X25519, each consumed once
//
// The server stores the public bundle and never sees any private key.
// Shared secret derivation follows the X3DH spec (DH1..DH4 -> HKDF).

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha512 } from '@noble/hashes/sha2.js';

export function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const X3DH_INFO = new TextEncoder().encode('flaxia/x3dh/v1');

export interface IdentityKeyPair {
  signPub: string;
  signPriv: string;
  dhPub: string;
  dhPriv: string;
}

export interface SignedPreKey {
  pub: string;
  priv: string;
  signature: string;
}

export interface OneTimePreKey {
  id: string;
  pub: string;
  priv: string;
}

export interface PreKeyBundle {
  identitySignPub: string;
  identityDhPub: string;
  signedPreKeyPub: string;
  signedPreKeySignature: string;
  preKeyPub?: string;
  preKeyId?: string;
}

function randomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bufToBase64(b);
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const sign = ed25519.keygen();
  const dh = x25519.keygen();
  return {
    signPub: bufToBase64(sign.publicKey),
    signPriv: bufToBase64(sign.secretKey),
    dhPub: bufToBase64(dh.publicKey),
    dhPriv: bufToBase64(dh.secretKey),
  };
}

export function generateSignedPreKey(identitySignPrivB64: string): SignedPreKey {
  const spk = x25519.keygen();
  const spkPubBytes = x25519.getPublicKey(spk.secretKey);
  const sig = ed25519.sign(spkPubBytes, base64ToBuf(identitySignPrivB64));
  return {
    pub: bufToBase64(spkPubBytes),
    priv: bufToBase64(spk.secretKey),
    signature: bufToBase64(sig),
  };
}

export function generateOneTimePreKeys(count: number): OneTimePreKey[] {
  const out: OneTimePreKey[] = [];
  for (let i = 0; i < count; i++) {
    const opk = x25519.keygen();
    out.push({
      id: randomId(),
      pub: bufToBase64(x25519.getPublicKey(opk.secretKey)),
      priv: bufToBase64(opk.secretKey),
    });
  }
  return out;
}

// Canonical associated data: the two identity DH public keys concatenated in a
// fixed (lexicographic) order so both parties derive the same AD.
export function canonicalAssociatedData(identityDhPubA: string, identityDhPubB: string): string {
  return identityDhPubA <= identityDhPubB
    ? `${identityDhPubA}|${identityDhPubB}`
    : `${identityDhPubB}|${identityDhPubA}`;
}

function deriveSharedKey(dhConcat: Uint8Array): Uint8Array {
  const okm = hkdf(sha512, dhConcat, new Uint8Array(0), X3DH_INFO, 32);
  return new Uint8Array(okm);
}

// Split the X3DH shared secret into the Double Ratchet initial root key and the
// shared chain key (initiator uses it as its initial sending chain; responder
// uses it as its initial receiving chain). Both parties derive the same pair.
export function deriveInitialRatchet(sharedKey: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const okm = hkdf(sha512, sharedKey, new Uint8Array(0), new TextEncoder().encode('flaxia/ratchet-init/v1'), 64);
  return { rootKey: new Uint8Array(okm.slice(0, 32)), chainKey: new Uint8Array(okm.slice(32, 64)) };
}

export interface X3DHInitiatorResult {
  sharedKey: Uint8Array;
  associatedData: string;
  ephemeralPub: string;
  ephemeralPriv: string;
  preKeyId?: string;
}

export function x3dhInitiate(
  identityDhPrivB64: string,
  identityDhPubB64: string,
  peerBundle: PreKeyBundle,
): X3DHInitiatorResult {
  // Authenticate the signed prekey before doing any DH. Without this a
  // malicious/compromised server could substitute its own SPK and MITM the
  // handshake. The signature binds the SPK to the peer's identity sign key.
  const spkPubBytes = base64ToBuf(peerBundle.signedPreKeyPub);
  let signatureValid = false;
  try {
    signatureValid = ed25519.verify(
      base64ToBuf(peerBundle.signedPreKeySignature),
      spkPubBytes,
      base64ToBuf(peerBundle.identitySignPub),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new Error('Invalid signed prekey signature');

  const ek = x25519.keygen();
  const ekPriv = ek.secretKey;
  const ekPub = x25519.getPublicKey(ek.secretKey);

  const dh1 = x25519.getSharedSecret(base64ToBuf(identityDhPrivB64), base64ToBuf(peerBundle.signedPreKeyPub));
  const dh2 = x25519.getSharedSecret(ekPriv, base64ToBuf(peerBundle.identityDhPub));
  const dh3 = x25519.getSharedSecret(ekPriv, base64ToBuf(peerBundle.signedPreKeyPub));
  const dh4 = peerBundle.preKeyPub
    ? x25519.getSharedSecret(ekPriv, base64ToBuf(peerBundle.preKeyPub))
    : new Uint8Array(0);

  const concat = new Uint8Array(dh1.length + dh2.length + dh3.length + dh4.length);
  concat.set(dh1, 0);
  concat.set(dh2, dh1.length);
  concat.set(dh3, dh1.length + dh2.length);
  concat.set(dh4, dh1.length + dh2.length + dh3.length);

  const sharedKey = deriveSharedKey(concat);
  const associatedData = canonicalAssociatedData(identityDhPubB64, peerBundle.identityDhPub);

  return {
    sharedKey,
    associatedData,
    ephemeralPub: bufToBase64(ekPub),
    ephemeralPriv: bufToBase64(ek.secretKey),
    preKeyId: peerBundle.preKeyId,
  };
}

export function x3dhRespond(
  identityDhPrivB64: string,
  identityDhPubB64: string,
  signedPreKeyPrivB64: string,
  oneTimePreKeyPrivB64: string | null,
  initiatorIdentityDhPubB64: string,
  ephemeralPubB64: string,
): { sharedKey: Uint8Array; associatedData: string } {
  const spkPriv = base64ToBuf(signedPreKeyPrivB64);
  const ekPub = base64ToBuf(ephemeralPubB64);

  const dh1 = x25519.getSharedSecret(spkPriv, base64ToBuf(initiatorIdentityDhPubB64));
  const dh2 = x25519.getSharedSecret(base64ToBuf(identityDhPrivB64), ekPub);
  const dh3 = x25519.getSharedSecret(spkPriv, ekPub);
  const dh4 = oneTimePreKeyPrivB64
    ? x25519.getSharedSecret(base64ToBuf(oneTimePreKeyPrivB64), ekPub)
    : new Uint8Array(0);

  const concat = new Uint8Array(dh1.length + dh2.length + dh3.length + dh4.length);
  concat.set(dh1, 0);
  concat.set(dh2, dh1.length);
  concat.set(dh3, dh1.length + dh2.length);
  concat.set(dh4, dh1.length + dh2.length + dh3.length);

  const sharedKey = deriveSharedKey(concat);
  const associatedData = canonicalAssociatedData(identityDhPubB64, initiatorIdentityDhPubB64);

  return { sharedKey, associatedData };
}
