import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { exportPrivateKey, exportPublicKey, generateKeyPair } from '../functions/lib/activitypub/crypto.ts';
import { handleSharedInbox, type InboxEnv } from '../functions/lib/activitypub/inbox.ts';
import { signRequest } from '../functions/lib/activitypub/signature.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const REMOTE_ACTOR = `${REMOTE}/users/alice`;
const KEY_ID = `${REMOTE_ACTOR}#main-key`;

interface QueueMessage {
  type: string;
  username?: string;
  activity?: Record<string, unknown>;
  actorId?: string;
}

interface CacheStub {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

function cacheStub(): CacheStub {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

let privateKeyPem = '';
let publicKeyPem = '';

function stubRemoteActor(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).startsWith(REMOTE)) return new Response('not found', { status: 404 });
    return new Response(
      JSON.stringify({
        id: REMOTE_ACTOR,
        type: 'Person',
        preferredUsername: 'alice',
        inbox: `${REMOTE_ACTOR}/inbox`,
        publicKey: { id: KEY_ID, owner: REMOTE_ACTOR, publicKeyPem },
      }),
      { headers: { 'Content-Type': 'application/activity+json' } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe('ActivityPub inbox', () => {
  let db: TestDatabase;
  let queue: QueueMessage[];

  before(async () => {
    db = createTestDatabase();
    await seedLocalUser(db, { id: 'local-1', username: 'alice' });
    const pair = await generateKeyPair();
    privateKeyPem = await exportPrivateKey(pair.privateKey);
    publicKeyPem = await exportPublicKey(pair.publicKey);
    queue = [];
  });

  after(() => {
    db.close();
  });

  function env(): InboxEnv {
    return {
      DB: db as unknown as InboxEnv['DB'],
      BASE_URL: BASE,
      CACHE: cacheStub() as unknown as InboxEnv['CACHE'],
      AP_DELIVERY_QUEUE: {
        async send(message: QueueMessage) {
          queue.push(message);
        },
      } as unknown as InboxEnv['AP_DELIVERY_QUEUE'],
    };
  }

  async function signedRequest(activity: Record<string, unknown>, target = `${BASE}/api/inbox`) {
    const body = JSON.stringify(activity);
    // The sender signs the request for the inbox it delivers to, so the
    // signature covers the host of this instance.
    const headers = await signRequest(target, body, privateKeyPem, KEY_ID);
    return new Request(target, { method: 'POST', headers, body });
  }

  it('accepts a signed activity that addresses a local actor', async () => {
    const restore = stubRemoteActor();
    try {
      queue.length = 0;
      const request = await signedRequest({
        id: `${REMOTE}/activities/inbox-1`,
        type: 'Follow',
        actor: REMOTE_ACTOR,
        to: [`${BASE}/api/actors/alice`],
        object: `${BASE}/api/actors/alice`,
      });
      const response = await handleSharedInbox(env(), request);
      assert.equal(response.status, 202);
      assert.equal(queue.length, 1);
      assert.equal(queue[0].username, 'alice');
      assert.equal(queue[0].actorId, REMOTE_ACTOR);
      assert.equal(queue[0].activity?.type, 'Follow');
    } finally {
      restore();
    }
  });

  it('refuses an activity without a signature', async () => {
    const request = new Request(`${BASE}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/activity+json' },
      body: JSON.stringify({ type: 'Follow', actor: REMOTE_ACTOR }),
    });
    const response = await handleSharedInbox(env(), request);
    assert.equal(response.status, 401);
  });

  it('refuses a body that the signature does not cover', async () => {
    const restore = stubRemoteActor();
    try {
      const request = await signedRequest({
        id: `${REMOTE}/activities/inbox-2`,
        type: 'Follow',
        actor: REMOTE_ACTOR,
        to: [`${BASE}/api/actors/alice`],
      });
      const tampered = new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({ type: 'Delete', actor: REMOTE_ACTOR }),
      });
      const response = await handleSharedInbox(env(), tampered);
      assert.equal(response.status, 401);
    } finally {
      restore();
    }
  });

  it('refuses a key that lives on another origin than the actor', async () => {
    const body = JSON.stringify({ id: `${REMOTE}/activities/inbox-3`, type: 'Follow', actor: REMOTE_ACTOR });
    const headers = await signRequest(
      `${BASE}/api/inbox`,
      body,
      privateKeyPem,
      'https://evil.example/users/alice#main-key',
    );
    const request = new Request(`${BASE}/api/inbox`, { method: 'POST', headers, body });
    const response = await handleSharedInbox(env(), request);
    assert.equal(response.status, 401);
  });

  it('refuses a request of another content type', async () => {
    const request = new Request(`${BASE}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    const response = await handleSharedInbox(env(), request);
    assert.equal(response.status, 400);
  });

  it('drops an exact replay of a delivery', async () => {
    const restore = stubRemoteActor();
    try {
      queue.length = 0;
      const activity = {
        id: `${REMOTE}/activities/inbox-4`,
        type: 'Follow',
        actor: REMOTE_ACTOR,
        to: [`${BASE}/api/actors/alice`],
      };
      const sharedEnv = env();
      const first = await handleSharedInbox(sharedEnv, await signedRequest(activity));
      assert.equal(first.status, 202);
      const second = await handleSharedInbox(sharedEnv, await signedRequest(activity));
      assert.equal(second.status, 202);
      const body = (await second.json()) as { duplicate?: boolean };
      assert.equal(body.duplicate, true);
      assert.equal(queue.length, 1, 'a replay must not be queued twice');
    } finally {
      restore();
    }
  });

  it('ignores an activity that addresses no local account', async () => {
    const restore = stubRemoteActor();
    try {
      queue.length = 0;
      const request = await signedRequest({
        id: `${REMOTE}/activities/inbox-5`,
        type: 'Create',
        actor: REMOTE_ACTOR,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      });
      const response = await handleSharedInbox(env(), request);
      assert.equal(response.status, 202);
      assert.equal(queue.length, 0);
    } finally {
      restore();
    }
  });
});
