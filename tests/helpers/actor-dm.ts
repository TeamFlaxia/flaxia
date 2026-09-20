// Standalone E2EE DM actor run as its own process so each "user" gets a
// distinct in-memory identity + KEK (the client libs cache identity globally
// per process, exactly like two browser tabs). Acts on env vars:
//   ROLE, COOKIE, PEERID, DMID, STEP, IN, OUT, EXPECT, PLAINTEXT
// Steps:
//   encrypt        -> generate identity, encrypt PLAINTEXT, write envelope to OUT
//   encrypt-reset  -> same as encrypt but call resetDmRatchet first (re-establish)
//   decrypt        -> generate identity, read envelope from IN, assert decrypt == EXPECT
//   decrypt-reply  -> decrypt from IN (assert == EXPECT) then encrypt PLAINTEXT reply to OUT
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
const makeStorage = () => ({
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});
g.sessionStorage = makeStorage();
g.localStorage = makeStorage();

// Reuse a stable device id across actor processes so a persisted ratchet
// session (stored per device) is visible on the next "reload" process, exactly
// like a browser tab that keeps localStorage.
if (process.env.DEVICE_ID) store.set('flaxia_device_id', process.env.DEVICE_ID);

const BASE_URL = 'http://localhost:8788';
const cookie = process.env.COOKIE ?? '';
const realFetch = (globalThis.fetch as (input: string, init?: Record<string, unknown>) => Promise<Response>).bind(
  globalThis,
);
g.fetch = (input: string, init: Record<string, unknown> = {}) => {
  const url = input.startsWith('/') ? BASE_URL + input : input;
  const headers = new Headers((init.headers as HeadersInit) ?? {});
  if (cookie) headers.set('Cookie', cookie);
  return realFetch(url, { ...init, headers, credentials: undefined });
};

const { unlockOrCreateIdentityV2 } = await import('../../src/lib/messenger-identity-v2.ts');
const { encryptDmMessageV2, decryptDmMessageV2, resetDmRatchet } = await import(
  '../../src/lib/messenger-dm-session.ts'
);

const role = process.env.ROLE ?? '';
const peerId = process.env.PEERID ?? '';
const dmId = process.env.DMID ?? '';
const step = process.env.STEP ?? '';
const inPath = process.env.IN;
const outPath = process.env.OUT;
const expect = process.env.EXPECT ?? '';
const plaintext = process.env.PLAINTEXT ?? '';

await unlockOrCreateIdentityV2('password123');

if (step === 'bootstrap') {
  console.log(`[${role}] BOOTSTRAP_OK`);
} else if (step === 'encrypt' || step === 'encrypt-reset') {
  if (step === 'encrypt-reset') resetDmRatchet(dmId, peerId);
  const env = await encryptDmMessageV2(dmId, peerId, plaintext);
  const payload = JSON.stringify({ ct: env.ciphertext, header: env.header, x3dh: env.x3dh });
  writeFileSync(outPath!, payload);
  console.log(`[${role}] ENCRYPT_OK`);
} else if (step === 'decrypt' || step === 'decrypt-reply') {
  const raw = readFileSync(inPath!, 'utf8');
  const envAny = JSON.parse(raw) as { ct: string; header: unknown; x3dh: unknown };
  const contentJson = JSON.stringify({ ct: envAny.ct, x3dh: envAny.x3dh });
  const pt = await decryptDmMessageV2(dmId, peerId, contentJson, envAny.header as never);
  assert.equal(pt, expect, `[${role}] decrypted plaintext must match expected`);
  if (step === 'decrypt-reply') {
    const reply = await encryptDmMessageV2(dmId, peerId, plaintext);
    const payload = JSON.stringify({ ct: reply.ciphertext, header: reply.header, x3dh: reply.x3dh });
    writeFileSync(outPath!, payload);
  }
  console.log(`[${role}] DECRYPT_OK`);
} else {
  throw new Error(`unknown STEP: ${step}`);
}
