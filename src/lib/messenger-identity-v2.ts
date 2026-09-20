// Messenger E2EE v2 identity lifecycle (X3DH + Double Ratchet).
//
// Generates an Ed25519 (sign) + X25519 (dh) identity, a signed X25519 prekey,
// and a pool of one-time prekeys. Private material is wrapped with a KEK derived
// from the user's password (PBKDF2 -> AES-GCM) before being sent to the server,
// so the server never sees plaintext private keys. The decrypted identity is
// kept in memory; the KEK is persisted in sessionStorage to survive reloads
// without re-entering the password.

import { replenishOpks } from './messenger-prekeys.ts';
import {
  generateIdentityKeyPair,
  generateOneTimePreKeys,
  generateSignedPreKey,
  type IdentityKeyPair,
  type SignedPreKey,
} from './messenger-x3dh.ts';

const KEK_STORAGE_KEY = 'flaxia_messenger_kek_v2';
// Mirror the KEK to localStorage as well so a freshly opened tab (which has its
// own sessionStorage) can still unlock the E2EE identity without re-entering
// the password. The KEK is session-bound material; localStorage is a
// convenience trade-off acceptable for this app.
const KEK_STORAGE_KEY_PERSIST = 'flaxia_messenger_kek_v2_persist';
const PBKDF2_ITERATIONS = 210000;
const OPK_COUNT = 20;

const subtle = globalThis.crypto?.subtle;
const te = new TextEncoder();

function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface IdentityV2 {
  identitySignPub: string;
  identitySignPriv: Uint8Array;
  identityDhPub: string;
  identityDhPriv: Uint8Array;
  spkPub: string;
  spkPriv: Uint8Array;
  spkSig: string;
}

let cached: IdentityV2 | null = null;
let kekCache: CryptoKey | null = null;

function storageAvailable(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && !!sessionStorage;
  } catch {
    return false;
  }
}

async function deriveKek(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle.importKey('raw', te.encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function wrapBytes(kek: CryptoKey, bytes: Uint8Array, iv?: Uint8Array): Promise<{ enc: string; iv: string }> {
  const usedIv = iv ?? new Uint8Array(12);
  if (!iv) globalThis.crypto.getRandomValues(usedIv);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: usedIv as BufferSource, tagLength: 128 },
    kek,
    bytes as BufferSource,
  );
  return { enc: bufToBase64(ct), iv: bufToBase64(usedIv) };
}

async function unwrapBytes(kek: CryptoKey, encB64: string, ivB64: string): Promise<Uint8Array> {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(ivB64) as BufferSource, tagLength: 128 },
    kek,
    base64ToBuf(encB64) as BufferSource,
  );
  return new Uint8Array(pt);
}

async function persistKek(kek: CryptoKey): Promise<void> {
  if (!storageAvailable()) return;
  try {
    const raw = await subtle.exportKey('raw', kek);
    const encoded = bufToBase64(raw);
    try {
      sessionStorage.setItem(KEK_STORAGE_KEY, encoded);
      localStorage.setItem(KEK_STORAGE_KEY_PERSIST, encoded);
    } catch {
      /* storage may be unavailable; in-memory identity still works */
    }
  } catch {
    /* non-extractable key; in-memory identity is enough for this session */
  }
}

async function loadKekFromSession(): Promise<CryptoKey | null> {
  if (!storageAvailable()) return null;
  const read = (key: string): string | null => {
    try {
      return sessionStorage.getItem(key) ?? localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const b64 = read(KEK_STORAGE_KEY);
  if (!b64) return null;
  try {
    return subtle.importKey('raw', base64ToBuf(b64) as BufferSource, { name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    try {
      sessionStorage.removeItem(KEK_STORAGE_KEY);
      localStorage.removeItem(KEK_STORAGE_KEY_PERSIST);
    } catch {
      /* ignore */
    }
    return null;
  }
}

// Resolve the KEK salt: callers that already hold the account (SRP) salt pass
// it explicitly so login and E2EE share one password; standalone callers may
// omit it, in which case a random salt is minted and stored server-side as
// encSalt so a later unlock can still re-derive the same KEK.
function resolveSalt(salt?: Uint8Array): Uint8Array {
  if (salt && salt.length > 0) return salt;
  const s = new Uint8Array(16);
  globalThis.crypto.getRandomValues(s);
  return s;
}

// Generate a fresh identity, publish it, and unlock it in memory.
export async function generateAndPublishIdentityV2(password: string, salt?: Uint8Array): Promise<boolean> {
  if (cached) return true;
  try {
    const id: IdentityKeyPair = generateIdentityKeyPair();
    const spk: SignedPreKey = generateSignedPreKey(id.signPriv);
    const opks = generateOneTimePreKeys(OPK_COUNT);

    const effectiveSalt = resolveSalt(salt);
    const kek = await deriveKek(password, effectiveSalt);
    kekCache = kek;

    const signPrivEnc = await wrapBytes(kek, base64ToBuf(id.signPriv));
    const dhPrivEnc = await wrapBytes(kek, base64ToBuf(id.dhPriv));
    const spkPrivEnc = await wrapBytes(kek, base64ToBuf(spk.priv));
    const opkWrapped: Array<{ id: string; pub: string; privEnc: string; privIv: string }> = [];
    for (const o of opks) {
      const w = await wrapBytes(kek, base64ToBuf(o.priv));
      opkWrapped.push({ id: o.id, pub: o.pub, privEnc: w.enc, privIv: w.iv });
    }

    const res = await fetch('/api/messenger/identity-v2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        identitySignPub: id.signPub,
        identitySignPrivEnc: signPrivEnc.enc,
        identitySignPrivIv: signPrivEnc.iv,
        identityDhPub: id.dhPub,
        identityDhPrivEnc: dhPrivEnc.enc,
        identityDhPrivIv: dhPrivEnc.iv,
        spkPub: spk.pub,
        spkPrivEnc: spkPrivEnc.enc,
        spkPrivIv: spkPrivEnc.iv,
        spkSig: spk.signature,
        opks: opkWrapped,
        encSalt: bufToBase64(effectiveSalt),
      }),
    });
    if (!res.ok) return false;

    cached = {
      identitySignPub: id.signPub,
      identitySignPriv: base64ToBuf(id.signPriv),
      identityDhPub: id.dhPub,
      identityDhPriv: base64ToBuf(id.dhPriv),
      spkPub: spk.pub,
      spkPriv: base64ToBuf(spk.priv),
      spkSig: spk.signature,
    };
    await persistKek(kek);
    return true;
  } catch {
    return false;
  }
}

// Re-unlock using the session KEK (no password prompt needed).
export async function unlockIdentityV2FromSession(): Promise<boolean> {
  if (cached) return true;
  const kek = await loadKekFromSession();
  if (!kek) return false;
  kekCache = kek;
  return applyUnlocked(kek);
}

interface IdentityPayload {
  exists?: boolean;
  identitySignPub?: string;
  identitySignPrivEnc?: string;
  identitySignPrivIv?: string;
  identityDhPub?: string;
  identityDhPrivEnc?: string;
  identityDhPrivIv?: string;
  spkPub?: string;
  spkPrivEnc?: string;
  spkPrivIv?: string;
  spkSig?: string;
  encSalt?: string;
}

async function fetchIdentityPayload(): Promise<IdentityPayload | null> {
  try {
    const res = await fetch('/api/messenger/identity-v2', { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as IdentityPayload;
  } catch {
    return null;
  }
}

async function applyUnlockedData(kek: CryptoKey, data: IdentityPayload): Promise<boolean> {
  try {
    if (!data.exists || !data.identitySignPrivEnc || !data.identitySignPrivIv) return false;
    cached = {
      identitySignPub: data.identitySignPub || '',
      identitySignPriv: await unwrapBytes(kek, data.identitySignPrivEnc, data.identitySignPrivIv),
      identityDhPub: data.identityDhPub || '',
      identityDhPriv: await unwrapBytes(kek, data.identityDhPrivEnc || '', data.identityDhPrivIv || ''),
      spkPub: data.spkPub || '',
      spkPriv: await unwrapBytes(kek, data.spkPrivEnc || '', data.spkPrivIv || ''),
      spkSig: data.spkSig || '',
    };
    void ensureOpkPool();
    return true;
  } catch {
    return false;
  }
}

async function applyUnlocked(kek: CryptoKey): Promise<boolean> {
  const data = await fetchIdentityPayload();
  if (!data) return false;
  return applyUnlockedData(kek, data);
}

// Unlock an existing identity using the user's password. The KEK is always
// derived from the server-stored `encSalt` — a single authoritative salt — so
// login and E2EE can never drift apart.
export async function unlockIdentityV2WithPassword(password: string): Promise<boolean> {
  if (cached) return true;
  const data = await fetchIdentityPayload();
  if (!data) return false;
  if (!data.exists) return false;
  if (!data.encSalt) return false;
  try {
    const kek = await deriveKek(password, base64ToBuf(data.encSalt));
    if (!(await applyUnlockedData(kek, data))) return false;
    kekCache = kek;
    await persistKek(kek);
    return true;
  } catch {
    return false;
  }
}

// Ensure an E2EE identity exists and is unlocked.
//
// The KEK is always derived from the server-stored `encSalt` (never the SRP
// salt), so a single login password unlocks E2EE on any device automatically.
// An existing identity is NEVER overwritten: if it cannot be decrypted we fail
// loudly instead of destroying the user's message history.
export async function ensureE2EEIdentityV2(password: string): Promise<boolean> {
  if (cached) return true;
  const data = await fetchIdentityPayload();
  if (!data) return false; // network/transient error: do not create or destroy

  if (data.exists) {
    if (!data.encSalt) return false;
    try {
      const kek = await deriveKek(password, base64ToBuf(data.encSalt));
      if (!(await applyUnlockedData(kek, data))) return false; // wrong password / corrupt
      kekCache = kek;
      await persistKek(kek);
      return true;
    } catch {
      return false;
    }
  }

  // No identity yet: create one, wrapped with a KEK derived from a random
  // encSalt that is stored alongside it.
  return generateAndPublishIdentityV2(password);
}

// Re-wrap the already-unlocked identity with a new KEK derived from a changed
// password + salt, keeping the same identity/signing keys (so peers' existing
// prekey bundles stay valid). One-time prekeys are regenerated and re-wrapped.
export async function rewrapE2EEIdentityV2(password: string, salt: Uint8Array): Promise<boolean> {
  if (!cached) return false;
  try {
    const newKek = await deriveKek(password, salt);
    const signPrivEnc = await wrapBytes(newKek, cached.identitySignPriv);
    const dhPrivEnc = await wrapBytes(newKek, cached.identityDhPriv);
    const spkPrivEnc = await wrapBytes(newKek, cached.spkPriv);
    const opks = generateOneTimePreKeys(OPK_COUNT);
    const opkWrapped: Array<{ id: string; pub: string; privEnc: string; privIv: string }> = [];
    for (const o of opks) {
      const w = await wrapBytes(newKek, base64ToBuf(o.priv));
      opkWrapped.push({ id: o.id, pub: o.pub, privEnc: w.enc, privIv: w.iv });
    }
    const res = await fetch('/api/messenger/identity-v2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        identitySignPub: cached.identitySignPub,
        identitySignPrivEnc: signPrivEnc.enc,
        identitySignPrivIv: signPrivEnc.iv,
        identityDhPub: cached.identityDhPub,
        identityDhPrivEnc: dhPrivEnc.enc,
        identityDhPrivIv: dhPrivEnc.iv,
        spkPub: cached.spkPub,
        spkPrivEnc: spkPrivEnc.enc,
        spkPrivIv: spkPrivEnc.iv,
        spkSig: cached.spkSig,
        opks: opkWrapped,
        encSalt: bufToBase64(salt),
      }),
    });
    if (!res.ok) return false;
    kekCache = newKek;
    await persistKek(newKek);
    return true;
  } catch {
    return false;
  }
}

// Unlock an existing identity with the password, or create a fresh one if none
// exists yet. Returns true once the in-memory identity is usable.
// Safety: if the server already has an identity, NEVER overwrite it — a failed
// unlock (network timeout, wrong password, etc.) must not destroy the real key.
export async function unlockOrCreateIdentityV2(password: string): Promise<boolean> {
  if (cached) return true;
  if (await unlockIdentityV2WithPassword(password)) return true;
  // If an identity already exists but could not be unlocked, fail rather than
  // overwrite it — a transient failure must never destroy the real key.
  const data = await fetchIdentityPayload();
  if (!data) return false;
  if (data.exists) return false;
  return generateAndPublishIdentityV2(password);
}

export function isIdentityV2Unlocked(): boolean {
  return !!cached;
}

export function getIdentityV2(): IdentityV2 | null {
  return cached;
}

// Expose the in-memory E2EE KEK so other modules (e.g. ratchet session
// persistence) can wrap/unwrap material without re-deriving the password.
export function getE2EEK(): CryptoKey | null {
  return kekCache;
}

// Clear in-memory identity + KEK (call on logout / before simulating a reload).
export function logoutE2EE(): void {
  cached = null;
  kekCache = null;
  try {
    sessionStorage.removeItem(KEK_STORAGE_KEY);
    localStorage.removeItem(KEK_STORAGE_KEY_PERSIST);
  } catch {
    /* ignore */
  }
}

// Cache of already-consumed OPK privates, keyed by opk id. The server deletes
// the OPK on first consume, so re-decrypting the same X3DH message (e.g. on a
// re-render) must reuse the previously unwrapped private instead of hitting the
// now-404 endpoint (which would otherwise yield a ratchet missing the DH4 step).
const consumedOpkCache = new Map<string, Uint8Array>();

// Unit-test hooks: inject an unlocked identity/KEK and pre-consumed OPK
// privates so session-level tests can run without the password unlock flow
// or a live server.
export function __setIdentityV2ForTests(me: IdentityV2, kek: CryptoKey): void {
  cached = me;
  kekCache = kek;
}

export function __seedConsumedOpkForTests(opkId: string, privB64: string): void {
  consumedOpkCache.set(opkId, base64ToBuf(privB64));
}
// OPK ids already known to be gone (server 404). Old pre-fix messages carry
// bootstraps referencing these; without this cache every render would re-fire
// a doomed consume request for each of them.
const deadOpkIds = new Set<string>();

// Top up our one-time prekey pool when it runs low. The server deletes an OPK
// after each X3DH consume, and only the client (holding the KEK) can generate
// new private material — so replenishment has to happen here. Best-effort.
export async function ensureOpkPool(): Promise<void> {
  if (!kekCache) return;
  try {
    const res = await fetch('/api/messenger/opks', { credentials: 'include' });
    if (!res.ok) return;
    const { count } = (await res.json()) as { count?: number };
    const have = count ?? 0;
    if (have >= OPK_COUNT) return;
    const opks = generateOneTimePreKeys(OPK_COUNT - have);
    const opkWrapped: Array<{ id: string; pub: string; privEnc: string; privIv: string }> = [];
    for (const o of opks) {
      const w = await wrapBytes(kekCache, base64ToBuf(o.priv));
      opkWrapped.push({ id: o.id, pub: o.pub, privEnc: w.enc, privIv: w.iv });
    }
    await replenishOpks(opkWrapped);
  } catch {
    /* best-effort */
  }
}

// Fetch and consume one of our own one-time prekeys (returns raw private X25519
// bytes). The server deletes the OPK after this call so it can never be reused.
export async function consumeOwnOpkPriv(opkId: string): Promise<Uint8Array | null> {
  if (!kekCache) return null;
  const cached = consumedOpkCache.get(opkId);
  if (cached) return cached;
  if (deadOpkIds.has(opkId)) return null;
  try {
    const res = await fetch('/api/messenger/opks/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ opkId }),
    });
    console.debug('[consumeOwnOpkPriv]', opkId, '->', res.status);
    if (!res.ok) {
      if (res.status === 404) deadOpkIds.add(opkId);
      return null;
    }
    const data = (await res.json()) as { privEnc?: string; privIv?: string };
    if (!data.privEnc || !data.privIv) {
      deadOpkIds.add(opkId);
      return null;
    }
    const priv = await unwrapBytes(kekCache, data.privEnc, data.privIv);
    consumedOpkCache.set(opkId, priv);
    void ensureOpkPool();
    return priv;
  } catch {
    return null;
  }
}
