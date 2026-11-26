// Guards for the two federation shortcuts that must never run in production:
// direct (queue-less) delivery, and the legacy note/inbox URL spellings.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { exportPrivateKey, exportPublicKey, generateKeyPair } from '../functions/lib/activitypub/crypto.ts';
import { type DeliveryEnv, deliverDirect, isDirectDelivery } from '../functions/lib/activitypub/delivery.ts';
import { localPostIdFromNoteUrl } from '../functions/lib/activitypub/handlers.ts';
import { verifyHttpSignature } from '../functions/lib/activitypub/signature.ts';
import { legacyRedirect } from '../src/hooks.server.ts';

function envFor(environment?: string, flag?: string): DeliveryEnv {
  return {
    DB: {} as DeliveryEnv['DB'],
    BASE_URL: 'https://flaxia.app',
    ENVIRONMENT: environment,
    AP_DIRECT_DELIVERY: flag,
  };
}

describe('AP_DIRECT_DELIVERY is limited to test and development', () => {
  for (const environment of ['test', 'development', 'TEST', 'Development']) {
    it(`honours the flag in ${environment}`, () => {
      assert.equal(isDirectDelivery(envFor(environment, '1')), true);
      assert.equal(isDirectDelivery(envFor(environment, 'true')), true);
      assert.equal(isDirectDelivery(envFor(environment, '0')), false);
    });
  }

  for (const environment of [undefined, '', 'production', 'PRODUCTION', 'staging']) {
    it(`ignores the flag in ${environment ?? 'unset'}`, () => {
      assert.equal(isDirectDelivery(envFor(environment, '1')), false);
      assert.equal(isDirectDelivery(envFor(environment, 'true')), false);
    });
  }
});

describe('inbound note references accept canonical URLs', () => {
  it('resolves both the legacy and the canonical path', () => {
    for (const path of ['/notes/post-1', '/api/notes/post-1']) {
      assert.equal(localPostIdFromNoteUrl(`https://flaxia.app${path}`, 'https://flaxia.app'), 'post-1');
    }
  });

  it('still rejects other origins and unrelated paths', () => {
    assert.equal(localPostIdFromNoteUrl('https://example.com/notes/post-1', 'https://flaxia.app'), null);
    assert.equal(localPostIdFromNoteUrl('https://flaxia.app/api/actors/alice', 'https://flaxia.app'), null);
    assert.equal(localPostIdFromNoteUrl('not a url', 'https://flaxia.app'), null);
  });
});

describe('legacy actor inbox URLs', () => {
  it('redirects both /users and /actors inbox paths', () => {
    for (const path of ['/users/alice/inbox', '/actors/alice/inbox']) {
      assert.deepEqual(legacyRedirect(path), { location: '/api/actors/alice/inbox', status: 308 });
    }
  });
});

interface RecordedFetch {
  url: string;
  init: RequestInit | undefined;
}

/** Replace fetch for one test and record every call made through it. */
async function withRecordedFetch(
  respond: (url: string, init?: RequestInit) => Response,
  run: (calls: RecordedFetch[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: RecordedFetch[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

let senderPrivateKeyPem = '';
let senderPublicKeyPem = '';

before(async () => {
  const pair = await generateKeyPair();
  senderPrivateKeyPem = await exportPrivateKey(pair.privateKey);
  senderPublicKeyPem = await exportPublicKey(pair.publicKey);
});

/** A delivery env with a real actor key so a signed POST can actually be made. */
function deliveryEnv(options: { environment?: string; allowedPrivatePeers?: string } = {}): DeliveryEnv {
  const DB = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ private_key_pem: senderPrivateKeyPem }),
      }),
    }),
  } as unknown as DeliveryEnv['DB'];
  return {
    DB,
    BASE_URL: 'https://flaxia.app',
    ENVIRONMENT: options.environment ?? 'test',
    AP_DIRECT_DELIVERY: '1',
    AP_ALLOWED_PRIVATE_PEERS: options.allowedPrivatePeers,
  };
}

const activity = { type: 'Create', id: 'https://flaxia.app/notes/1' };

describe('deliverDirect rejects non-public inbox URLs', () => {
  for (const inboxUrl of [
    'http://127.0.0.1/inbox',
    'http://[::ffff:127.0.0.1]/inbox',
    'http://localhost/inbox',
    'http://metadata.google.internal/inbox',
  ]) {
    it(`never fetches a blocked inbox: ${inboxUrl}`, async () => {
      await withRecordedFetch(
        () => new Response(null, { status: 202 }),
        async (calls) => {
          const delivered = await deliverDirect(deliveryEnv(), { inboxUrl, username: 'alice', activity });
          assert.deepEqual(
            calls.map((call) => call.url),
            [],
            'a blocked inbox must not be fetched',
          );
          assert.equal(delivered, false);
        },
      );
    });
  }
});

describe('deliverDirect preserves signed public delivery', () => {
  it('sends one signed POST to a public https inbox', async () => {
    const inboxUrl = 'https://remote.example/users/bob/inbox';
    await withRecordedFetch(
      () => new Response(null, { status: 202 }),
      async (calls) => {
        const delivered = await deliverDirect(deliveryEnv(), { inboxUrl, username: 'alice', activity });
        assert.equal(delivered, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, inboxUrl);
        assert.equal(calls[0].init?.method, 'POST');
        assert.equal(calls[0].init?.body, JSON.stringify(activity));
        assert.equal(calls[0].init?.redirect, 'manual');

        const headers = new Headers(calls[0].init?.headers);
        assert.equal(headers.get('content-type'), 'application/activity+json');
        assert.match(headers.get('signature') ?? '', /keyId="https:\/\/flaxia\.app\/api\/actors\/alice#main-key"/);
        const request = new Request(inboxUrl, { method: 'POST', headers, body: JSON.stringify(activity) });
        assert.equal(await verifyHttpSignature(request, senderPublicKeyPem, { expectedHost: 'remote.example' }), true);
      },
    );
  });
});

describe('deliverDirect private peer allowance', () => {
  // Consistent with isPrivatePeerAllowed() in fetch.ts: an explicit allow list
  // makes a local federation peer reachable in test/development, and is
  // deliberately inert anywhere else. A mistaken production deployment must
  // not be able to POST a signed activity into the private network.
  it('delivers to an explicitly allowlisted private peer in the test environment', async () => {
    const inboxUrl = 'http://localhost:9999/inbox';
    const env = deliveryEnv({ environment: 'test', allowedPrivatePeers: 'localhost' });
    await withRecordedFetch(
      () => new Response(null, { status: 202 }),
      async (calls) => {
        const delivered = await deliverDirect(env, { inboxUrl, username: 'alice', activity });
        assert.equal(delivered, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, inboxUrl);
      },
    );
  });

  it('ignores the private peer allow list outside test and development', async () => {
    const inboxUrl = 'http://localhost:9999/inbox';
    const env = deliveryEnv({ environment: 'production', allowedPrivatePeers: 'localhost' });
    await withRecordedFetch(
      () => new Response(null, { status: 202 }),
      async (calls) => {
        const delivered = await deliverDirect(env, { inboxUrl, username: 'alice', activity });
        assert.deepEqual(
          calls.map((call) => call.url),
          [],
          'the allow list must not make a private peer reachable in production',
        );
        assert.equal(delivered, false);
      },
    );
  });
});
