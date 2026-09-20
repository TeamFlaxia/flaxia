// Integration test proving the X3DH OPK flow works through the real API:
// GET /prekeys must RESERVE (not delete) the OPK so the responder can later
// consume its private via POST /opks/consume. This is the exact bug that made
// received DM messages fail with "invalid tag".
//
// Requires a running `npm run dev:test` server on http://localhost:8788.
import assert from 'node:assert';
import { before, describe, it } from 'node:test';
import { generateAndPublishIdentityV2 } from '../src/lib/messenger-identity-v2.ts';
import { BASE_URL, seedUserAndLogin } from './helpers/setup.ts';

// --- browser polyfills for the client libs ---
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
const g = globalThis as unknown as Record<string, unknown>;
g.sessionStorage = makeStorage();
g.localStorage = makeStorage();

let cookie = '';
const realFetch = globalThis.fetch.bind(globalThis);
g.fetch = (input: unknown, init: Record<string, unknown> = {}) => {
  let url = typeof input === 'string' ? input : (input as { url: string }).url;
  if (url.startsWith('/')) url = BASE_URL + url;
  const headers = new Headers((init.headers as HeadersInit) ?? {});
  if (cookie) headers.set('Cookie', cookie);
  return realFetch(url, { ...init, headers, credentials: undefined });
};

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

let userId = '';

before(async () => {
  const login = await seedUserAndLogin('opkflow');
  cookie = login.cookie;
  const ok = await generateAndPublishIdentityV2('password123');
  assert.equal(ok, true, 'E2EE identity published');
  const me = (await json(await realFetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } }))) as {
    user: { id: string };
  };
  userId = me.user.id;
});

describe('X3DH OPK endpoint flow', () => {
  it('GET /prekeys reserves an OPK (does NOT delete it)', async () => {
    const b1 = (await json(
      await realFetch(`${BASE_URL}/api/messenger/prekeys?userId=${userId}`, { headers: { Cookie: cookie } }),
    )) as Record<string, unknown>;
    assert.ok(b1.preKeyId, 'first bundle carries an OPK id');
    const firstOpkId = b1.preKeyId as string;

    // The OPK must still be consumable after the bundle fetch => it was reserved,
    // not deleted. If it had been deleted, this would 404.
    const consume = await realFetch(`${BASE_URL}/api/messenger/opks/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ opkId: firstOpkId }),
    });
    assert.equal(consume.status, 200, 'responder can consume the reserved OPK private');
    const data = (await consume.json()) as { privEnc?: string; privIv?: string };
    assert.ok(data.privEnc && data.privIv, 'consume returns the OPK private material');

    // Re-consuming must succeed idempotently: the private material is retained
    // (still KEK-encrypted) so a responder whose ratchet session was lost can
    // rebuild the identical X3DH ratchet instead of permanently losing history.
    const consume2 = await realFetch(`${BASE_URL}/api/messenger/opks/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ opkId: firstOpkId }),
    });
    assert.equal(consume2.status, 200, 'OPK private stays available for ratchet recovery');
    const data2 = (await consume2.json()) as { privEnc?: string; privIv?: string };
    assert.equal(data2.privEnc, data.privEnc, 're-consume returns the same private material');
  });

  it('repeated prekey fetches hand out distinct reserved OPKs', async () => {
    const b1 = (await json(
      await realFetch(`${BASE_URL}/api/messenger/prekeys?userId=${userId}`, { headers: { Cookie: cookie } }),
    )) as Record<string, unknown>;
    const b2 = (await json(
      await realFetch(`${BASE_URL}/api/messenger/prekeys?userId=${userId}`, { headers: { Cookie: cookie } }),
    )) as Record<string, unknown>;
    assert.ok(b1.preKeyId, 'b1 has OPK');
    assert.ok(b2.preKeyId, 'b2 has OPK');
    assert.notEqual(b1.preKeyId, b2.preKeyId, 'two fetches reserve distinct OPKs (no double-handout)');
  });
});
