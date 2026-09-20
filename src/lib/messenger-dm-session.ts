// Per-conversation Double Ratchet session management for DMs (E2EE v2).
//
// Wires X3DH (key agreement) into the Double Ratchet: the first message carries
// an X3DH bootstrap; afterwards both sides continue with the ratchet alone.
// Private material never leaves the client; the server only stores ciphertext.

import { x25519 } from '@noble/curves/ed25519.js';
import { clearDmPlaintext, getDmPlaintext, putDmPlaintext } from './messenger-dm-cache.ts';
import { consumeOwnOpkPriv, getE2EEK, getIdentityV2, type IdentityV2 } from './messenger-identity-v2.ts';
import { checkRatchetResetRequest, clearRatchetResetRequest, fetchPreKeyBundle } from './messenger-prekeys.ts';
import { DoubleRatchet, type RatchetHeader } from './messenger-ratchet.ts';
import { bufToBase64, deriveInitialRatchet, type PreKeyBundle, x3dhInitiate, x3dhRespond } from './messenger-x3dh.ts';

export interface DmX3DHBootstrap {
  ikDhPub: string;
  ekPub: string;
  opkId: string;
}

export interface DmSendEnvelope {
  ciphertext: string;
  header: RatchetHeader;
  x3dh?: DmX3DHBootstrap;
}

interface DmSession {
  ratchet: DoubleRatchet;
  bootstrap?: DmX3DHBootstrap;
}

// Candidate sessions per conversation+peer, most-recently-successful first.
// History can contain messages from several abandoned X3DH sessions (each
// re-establishment leaves old bootstrap-bearing messages behind); keeping a
// few candidates lets us decrypt those replays WITHOUT clobbering the live
// session — the root cause of "sometimes it decrypts, sometimes it doesn't".
const sessions = new Map<string, DmSession[]>();
const MAX_SESSIONS = 5;
const sessionKey = (dmId: string, peerId: string) => `${dmId}:${peerId}`;

// Successfully decrypted plaintexts keyed by message position
// (`dmId:senderId:ratchetPub:n`). The UI re-renders history and re-runs
// decrypt on messages it has already shown; serving those from cache avoids
// pointless ratchet attempts (a second attempt at a consumed index can never
// succeed) and keeps console noise down.
const plaintextCache = new Map<string, string>();
const PLAINTEXT_CACHE_MAX = 500;
const plaintextKey = (dmId: string, senderId: string, pub: string, n: number) => `${dmId}:${senderId}:${pub}:${n}`;

const subtle = globalThis.crypto?.subtle;

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function freshRatchetPair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const k = x25519.keygen();
  return { secretKey: k.secretKey, publicKey: x25519.getPublicKey(k.secretKey) };
}

// Wrap/unwrap with the E2EE KEK so the server only ever stores ciphertext.
async function wrapWithKek(plain: Uint8Array): Promise<{ enc: string; iv: string }> {
  const kek = getE2EEK();
  if (!kek) throw new Error('E2EE KEK unavailable');
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 },
    kek,
    plain as BufferSource,
  );
  return { enc: bufToBase64(ct), iv: bufToBase64(iv) };
}

async function unwrapWithKek(encB64: string, ivB64: string): Promise<Uint8Array> {
  const kek = getE2EEK();
  if (!kek) throw new Error('E2EE KEK unavailable');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(ivB64) as BufferSource, tagLength: 128 },
    kek,
    base64ToBuf(encB64) as BufferSource,
  );
  return new Uint8Array(pt);
}

// Stable per-browser device id so each device keeps its own ratchet session
// instead of clobbering other devices' state in the single shared row.
function getDeviceId(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      let id = localStorage.getItem('flaxia_device_id');
      if (!id) {
        const b = new Uint8Array(16);
        globalThis.crypto.getRandomValues(b);
        id = bufToBase64(b);
        localStorage.setItem('flaxia_device_id', id);
      }
      return id;
    }
  } catch {
    /* storage unavailable */
  }
  return 'default';
}

// Persist the FULL candidate list (KEK-wrapped) for this conversation+device so
// the live session AND any replayed older sessions survive a reload. Storing the
// whole list (not just the last-touched candidate) is what keeps the live
// session from being dropped when an old history message is decrypted.
async function persistDmRatchet(conversationId: string, peerId: string): Promise<void> {
  try {
    const key = sessionKey(conversationId, peerId);
    const list = sessions.get(key);
    if (!list || list.length === 0) return;
    const serialized = list.map((s) => ({ ratchet: s.ratchet.serialize(), bootstrap: s.bootstrap ?? null }));
    const json = new TextEncoder().encode(JSON.stringify(serialized));
    const { enc, iv } = await wrapWithKek(json);
    await fetch('/api/messenger/ratchet-session', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        conversation_id: conversationId,
        device_id: getDeviceId(),
        session_enc: enc,
        session_iv: iv,
      }),
    });
  } catch {
    /* persistence is best-effort; the in-memory session still works */
  }
}

// Load the previously persisted candidate list for this conversation+device, or
// null. Restores the live session at index 0.
export async function loadDmRatchet(conversationId: string): Promise<DmSession[] | null> {
  try {
    if (!getE2EEK()) return null;
    const res = await fetch(
      `/api/messenger/ratchet-session?conversation_id=${encodeURIComponent(conversationId)}&device_id=${encodeURIComponent(getDeviceId())}`,
      { credentials: 'include' },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { exists?: boolean; session_enc?: string; session_iv?: string };
    if (!data.exists || !data.session_enc || !data.session_iv) return null;
    const json = JSON.parse(new TextDecoder().decode(await unwrapWithKek(data.session_enc, data.session_iv))) as Array<{
      ratchet: never;
      bootstrap: DmX3DHBootstrap | null;
    }>;
    if (!Array.isArray(json) || json.length === 0) return null;
    return json.map((s) => ({ ratchet: DoubleRatchet.deserialize(s.ratchet), bootstrap: s.bootstrap ?? undefined }));
  } catch {
    return null;
  }
}

async function clearDmRatchetOnServer(conversationId: string): Promise<void> {
  try {
    await fetch(
      `/api/messenger/ratchet-session?conversation_id=${encodeURIComponent(conversationId)}&device_id=${encodeURIComponent(getDeviceId())}`,
      { method: 'DELETE', credentials: 'include' },
    );
  } catch {
    /* ignore */
  }
}

// Pure builder: create the initiator's ratchet from a peer's prekey bundle.
export function buildInitiatorRatchet(
  me: IdentityV2,
  peerBundle: PreKeyBundle,
): { ratchet: DoubleRatchet; bootstrap: DmX3DHBootstrap } {
  const init = x3dhInitiate(bufToBase64(me.identityDhPriv), me.identityDhPub, peerBundle);
  const { rootKey, chainKey } = deriveInitialRatchet(init.sharedKey);
  const pair = freshRatchetPair();
  const ratchet = new DoubleRatchet({
    rootKey,
    associatedData: init.associatedData,
    sendRatchetPriv: pair.secretKey,
    sendRatchetPub: pair.publicKey,
    recvRatchetPub: null,
    initialSendChainKey: chainKey,
  });
  const bootstrap: DmX3DHBootstrap = {
    ikDhPub: me.identityDhPub,
    ekPub: init.ephemeralPub,
    opkId: init.preKeyId || '',
  };
  return { ratchet, bootstrap };
}

// Pure builder: create the responder's ratchet from an X3DH bootstrap message.
export function buildResponderRatchet(
  me: IdentityV2,
  oneTimePreKeyPrivB64: string | null,
  bootstrap: DmX3DHBootstrap,
): DoubleRatchet {
  const resp = x3dhRespond(
    bufToBase64(me.identityDhPriv),
    me.identityDhPub,
    bufToBase64(me.spkPriv),
    oneTimePreKeyPrivB64,
    bootstrap.ikDhPub,
    bootstrap.ekPub,
  );
  const { rootKey, chainKey } = deriveInitialRatchet(resp.sharedKey);
  const pair = freshRatchetPair();
  return new DoubleRatchet({
    rootKey,
    associatedData: resp.associatedData,
    sendRatchetPriv: pair.secretKey,
    sendRatchetPub: pair.publicKey,
    recvRatchetPub: null,
    initialRecvChainKey: chainKey,
  });
}

// Serialize session work per conversation+peer. The UI fires many concurrent
// decrypts when rendering history; without this lock each one that finds no
// in-memory session loads the persisted ratchet into a SEPARATE instance and
// they all advance their own copy of the chains (last persist wins, state
// corrupts). The lock also keeps ratchet operations strictly ordered.
const locks = new Map<string, Promise<unknown>>();
async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const done = run
    .catch(() => {})
    .finally(() => {
      if (locks.get(key) === done) locks.delete(key);
    });
  locks.set(key, done);
  return run;
}

// Encrypt a DM as the sender, bootstrapping X3DH on the first message or
// resuming from a persisted ratchet session (survives reload / other devices).
export function encryptDmMessageV2(dmId: string, peerId: string, plaintext: string): Promise<DmSendEnvelope> {
  return withSessionLock(sessionKey(dmId, peerId), () => encryptDmMessageV2Inner(dmId, peerId, plaintext));
}

async function encryptDmMessageV2Inner(dmId: string, peerId: string, plaintext: string): Promise<DmSendEnvelope> {
  const key = sessionKey(dmId, peerId);
  // Finish any pending server-side reset first so a just-abandoned session can
  // never be loaded back and reused (which would defeat "再確立").
  await awaitPendingReset(dmId);
  let list = sessions.get(key);
  if (!list || list.length === 0) {
    const loaded = await loadDmRatchet(dmId);
    if (loaded && loaded.length > 0) {
      // If the peer asked us to re-bootstrap (they could not decrypt our
      // messages, e.g. a stale pre-fix ratchet), discard the persisted session
      // so this send establishes a fresh X3DH ratchet — recovery works even
      // without actively polling the conversation.
      if (await checkRatchetResetRequest(dmId)) {
        await resetDmRatchet(dmId, peerId);
        await clearRatchetResetRequest(dmId);
        list = [];
      } else {
        list = loaded;
      }
    } else {
      list = [];
    }
    if (list.length === 0) {
      const me = getIdentityV2();
      if (!me) throw new Error('E2EE identity is locked');
      const bundle = await fetchPreKeyBundle(peerId);
      if (!bundle) throw new Error('Peer has no E2EE identity');
      const pk: PreKeyBundle = {
        identitySignPub: bundle.identitySignPub,
        identityDhPub: bundle.identityDhPub,
        signedPreKeyPub: bundle.signedPreKeyPub,
        signedPreKeySignature: bundle.signedPreKeySignature,
        preKeyPub: bundle.preKeyPub ?? undefined,
        preKeyId: bundle.preKeyId ?? undefined,
      };
      const built = buildInitiatorRatchet(me, pk);
      // Always attach the bootstrap. When the peer's OPK pool is empty
      // (preKeyId empty) this is a 2DH handshake — still enough for both sides
      // to derive matching keys, so re-establishment never gets stuck.
      list = [{ ratchet: built.ratchet, bootstrap: built.bootstrap }];
    }
    sessions.set(key, list);
  }
  const session = list[0];
  const msg = session.ratchet.encrypt(plaintext);
  // Only the first message of a fresh session carries the X3DH bootstrap.
  const envelope: DmSendEnvelope = { ciphertext: msg.ciphertext, header: msg.header, x3dh: session.bootstrap };
  session.bootstrap = undefined;
  await persistDmRatchet(dmId, peerId);
  return envelope;
}

// Decrypt a received DM, bootstrapping the responder ratchet if needed or
// resuming from a persisted ratchet session.
export function decryptDmMessageV2(
  dmId: string,
  senderId: string,
  contentJson: string,
  header: RatchetHeader,
): Promise<string> {
  return withSessionLock(sessionKey(dmId, senderId), () =>
    decryptDmMessageV2Inner(dmId, senderId, contentJson, header),
  );
}

async function decryptDmMessageV2Inner(
  dmId: string,
  senderId: string,
  contentJson: string,
  header: RatchetHeader,
): Promise<string> {
  const parsed = JSON.parse(contentJson) as { ct: string; x3dh?: DmX3DHBootstrap };
  const key = sessionKey(dmId, senderId);
  const cacheKey = header ? plaintextKey(dmId, senderId, header.ratchetPub, header.n) : null;
  if (cacheKey) {
    const cached = plaintextCache.get(cacheKey);
    if (cached !== undefined) return cached;
    // After a reload / re-open the in-memory cache is gone and the ratchet has
    // advanced past this message, so re-derivation would fail. Fall back to the
    // durable KEK-encrypted plaintext cache before touching the ratchet.
    const persisted = await getDmPlaintext(cacheKey);
    if (persisted !== null) {
      plaintextCache.set(cacheKey, persisted);
      return persisted;
    }
  }

  const tryDecrypt = async (session: DmSession): Promise<string> => {
    let own: string | null = null;
    try {
      own = session.ratchet.decryptOwn({ header, ciphertext: parsed.ct });
    } catch {
      own = null;
    }
    return own ?? session.ratchet.decrypt({ header, ciphertext: parsed.ct });
  };
  const rememberPlaintext = (plaintext: string) => {
    if (!cacheKey) return;
    if (plaintextCache.size >= PLAINTEXT_CACHE_MAX) {
      const first = plaintextCache.keys().next();
      if (first.value) plaintextCache.delete(first.value);
    }
    plaintextCache.set(cacheKey, plaintext);
    // Durably persist so the plaintext survives a reload even though the ratchet
    // can no longer recompute the consumed message key.
    void putDmPlaintext(cacheKey, plaintext);
  };

  let list = sessions.get(key);
  if (!list || list.length === 0) {
    list = [];
    sessions.set(key, list);
    const loaded = await loadDmRatchet(dmId);
    if (loaded && loaded.length) list.push(...loaded);
  }

  // Try each known candidate — most-recently-successful first. A healthy live
  // session therefore always wins, and replayed history messages from older
  // sessions can no longer clobber it (the old code rebuilt the responder
  // ratchet from ANY bootstrap it could complete, replacing the live session
  // and breaking every subsequent message until the next lucky re-bootstrap).
  let lastError: unknown = null;
  for (const candidate of [...list]) {
    try {
      const plaintext = await tryDecrypt(candidate);
      list.splice(list.indexOf(candidate), 1);
      list.unshift(candidate);
      if (list.length > MAX_SESSIONS) list.pop();
      rememberPlaintext(plaintext);
      await persistDmRatchet(dmId, senderId);
      return plaintext;
    } catch (e) {
      lastError = e;
    }
  }

  // Every candidate failed. If the message carries an X3DH bootstrap we can
  // still recover: build a matching responder ratchet and keep it alongside
  // the existing candidates instead of discarding them.
  if (parsed.x3dh) {
    const me = getIdentityV2();
    if (!me) throw new Error('E2EE identity is locked');
    let opkPrivB64: string | null = null;
    if (parsed.x3dh.opkId) {
      const opkPriv = await consumeOwnOpkPriv(parsed.x3dh.opkId);
      opkPrivB64 = opkPriv ? bufToBase64(opkPriv) : null;
    }
    // Build a responder ratchet for 3DH (opkId present and consumed) or for the
    // 2DH fallback when the peer had no one-time prekey (opkId empty). Only skip
    // when a 3DH opkId was present but its private is gone — that bootstrap can
    // never be completed.
    if (opkPrivB64 || !parsed.x3dh.opkId) {
      const rebuilt: DmSession = { ratchet: buildResponderRatchet(me, opkPrivB64, parsed.x3dh) };
      const plaintext = await tryDecrypt(rebuilt);
      list.unshift(rebuilt);
      if (list.length > MAX_SESSIONS) list.pop();
      rememberPlaintext(plaintext);
      await persistDmRatchet(dmId, senderId);
      return plaintext;
    }
    if (list.length === 0 && parsed.x3dh.opkId) {
      // Bootstrap present but its one-time prekey is gone (a message sent
      // before the X3DH OPK-handling fix deleted it). Permanently undecryptable.
      throw new Error(`OPK_UNRECOVERABLE conv=${dmId} peer=${senderId} opkId=${parsed.x3dh.opkId}`);
    }
  }

  if (list.length === 0 && !parsed.x3dh) {
    throw new Error('No ratchet session and no X3DH bootstrap');
  }
  throw lastError ?? new Error('DM v2 decrypt failed');
}

export function clearDmSessions(): void {
  for (const key of sessions.keys()) {
    const convId = key.split(':')[0];
    void clearDmRatchetOnServer(convId);
    void clearDmPlaintext(convId);
  }
  sessions.clear();
}

// In-flight server-side ratchet deletions, keyed by conversation. A reset is
// requested from the UI (button / peer request) and the very next send must
// re-bootstrap X3DH; if the DELETE has not landed yet, `loadDmRatchet` would
// resurrect the just-abandoned session and the "reset" would silently fail.
// Awaiting this promise before loading closes that race.
const resetPromises = new Map<string, Promise<void>>();

async function awaitPendingReset(dmId: string): Promise<void> {
  const p = resetPromises.get(dmId);
  if (p) await p;
}

// Discard the local + persisted ratchet for a single DM so the next outgoing
// message re-bootstraps X3DH from scratch (recovering a broken session). The
// peer automatically rebuilds its side when it receives the new bootstrap.
//
// The durable plaintext cache is intentionally NOT cleared: it is the last copy
// of already-decrypted history and the ratchet can never recompute consumed
// message keys, so wiping it would permanently blank the conversation.
export function resetDmRatchet(dmId: string, peerId: string): Promise<void> {
  sessions.delete(sessionKey(dmId, peerId));
  const prev = resetPromises.get(dmId) ?? Promise.resolve();
  const p = prev.then(
    () => clearDmRatchetOnServer(dmId),
    () => clearDmRatchetOnServer(dmId),
  );
  resetPromises.set(dmId, p);
  void p.finally(() => {
    if (resetPromises.get(dmId) === p) resetPromises.delete(dmId);
  });
  return p;
}

// Unit-test hooks: inject/clear candidate sessions without the unlock flow.
export function __setSessionForTests(dmId: string, peerId: string, ratchet: DoubleRatchet): void {
  sessions.set(sessionKey(dmId, peerId), [{ ratchet }]);
}

export function __clearSessionsForTests(): void {
  sessions.clear();
  plaintextCache.clear();
}

// Test hook: drop only the in-memory plaintext cache (simulating a reload while
// the durable store is left intact) so the persisted-cache fallback can be
// exercised.
export function __clearInMemoryPlaintextCacheForTests(): void {
  plaintextCache.clear();
}
