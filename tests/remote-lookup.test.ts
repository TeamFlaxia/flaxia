// Handle validation, SSRF rejection, KV caching and rate limiting for the
// remote lookup helper. All network access is stubbed; nothing leaves the test.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FederationEnv } from '../functions/lib/activitypub/fetch.ts';
import {
  lookupRemoteHandle,
  lookupRemoteHandleAt,
  lookupRemoteHandleCached,
  parseRemoteHandle,
  remoteLookupCacheKey,
  remoteLookupRateLimitKey,
  toRemoteLookupDto,
} from '../functions/lib/activitypub/lookup.ts';
import { checkRateLimit } from '../functions/lib/rate-limit.ts';

const REMOTE_ENV: FederationEnv = { BASE_URL: 'https://flaxia.app', ENVIRONMENT: 'production' };
const ACTOR_URL = 'https://example.com/users/bob';

function webfingerResponse(href: string): Response {
  return Response.json(
    {
      subject: 'acct:bob@example.com',
      links: [{ rel: 'self', type: 'application/activity+json', href }],
    },
    { status: 200 },
  );
}

function actorResponse(id = ACTOR_URL): Response {
  return Response.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id,
    type: 'Person',
    preferredUsername: 'bob',
    name: 'Bob Example',
    inbox: `${id}/inbox`,
    icon: { type: 'Image', url: 'https://example.com/avatar.png' },
  });
}

async function withStubbedFetch(
  respond: (url: string) => Response | Promise<Response>,
  run: (requests: string[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return respond(url);
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

function makeKv(): { kv: KVNamespace; store: Map<string, { value: string; ttl?: number }> } {
  const store = new Map<string, { value: string; ttl?: number }>();
  const kv = {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, ttl: options?.expirationTtl });
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

describe('strict remote handle validation', () => {
  it('accepts only user@domain handles', () => {
    assert.deepEqual(parseRemoteHandle('@bob@example.com'), { username: 'bob', domain: 'example.com' });
    assert.deepEqual(parseRemoteHandle('bob@sub.example.co.uk'), { username: 'bob', domain: 'sub.example.co.uk' });
    assert.equal(parseRemoteHandle('bob'), null);
    assert.equal(parseRemoteHandle('@bob@localhost'), null);
    assert.equal(parseRemoteHandle('bob@127.0.0.1'), null);
    assert.equal(parseRemoteHandle('bob@example.com/path'), null);
    assert.equal(parseRemoteHandle('bob@example.com@evil.test'), null);
    assert.equal(parseRemoteHandle('https://evil.test/x@bob@example.com'), null);
    assert.deepEqual(parseRemoteHandle('  @bob@example.com  '), { username: 'bob', domain: 'example.com' });
  });

  it('never builds a WebFinger URL from an invalid handle', async () => {
    await withStubbedFetch(
      () => {
        throw new Error('unexpected fetch');
      },
      async (requests) => {
        for (const handle of ['bob@127.0.0.1', 'bob@localhost', 'bob@example.com/path', 'bob@[::1]', 'not-a-handle']) {
          assert.equal(await lookupRemoteHandle(handle, REMOTE_ENV), null, handle);
        }
        assert.deepEqual(requests, []);
      },
    );
  });
});

describe('SSRF-safe WebFinger and actor resolution', () => {
  it('resolves a validated handle through WebFinger and the actor document', async () => {
    await withStubbedFetch(
      (url) => (url.includes('/.well-known/webfinger') ? webfingerResponse(ACTOR_URL) : actorResponse()),
      async (requests) => {
        const actor = await lookupRemoteHandle('@bob@example.com', REMOTE_ENV);
        assert.ok(actor);
        assert.equal(actor.actorUrl, ACTOR_URL);
        assert.equal(actor.preferredUsername, 'bob');
        assert.equal(actor.displayName, 'Bob Example');
        assert.equal(actor.domain, 'example.com');
        assert.equal(requests.length, 2);
        assert.ok(requests[0].startsWith('https://example.com/.well-known/webfinger?resource='));
        assert.equal(requests[1], ACTOR_URL);

        assert.deepEqual(toRemoteLookupDto(actor), {
          handle: '@bob@example.com',
          displayName: 'Bob Example',
          avatarUrl: 'https://example.com/avatar.png',
          actorUrl: ACTOR_URL,
          domain: 'example.com',
        });
      },
    );
  });

  it('rejects a WebFinger redirect into a private network without following it', async () => {
    await withStubbedFetch(
      () => new Response(null, { status: 302, headers: { Location: 'http://localhost/secret' } }),
      async (requests) => {
        assert.equal(await lookupRemoteHandle('bob@example.com', REMOTE_ENV), null);
        assert.equal(requests.length, 1, 'a private redirect must not be fetched');
      },
    );
  });

  it('rejects an actor document hosted on a private origin', async () => {
    await withStubbedFetch(
      (url) =>
        url.includes('/.well-known/webfinger') ? webfingerResponse('http://127.0.0.1/users/bob') : actorResponse(),
      async (requests) => {
        assert.equal(await lookupRemoteHandle('bob@example.com', REMOTE_ENV), null);
        assert.equal(requests.length, 1);
      },
    );
  });

  it('keeps the allowlisted private peer with a host:port working', async () => {
    const env: FederationEnv = { ENVIRONMENT: 'test', AP_ALLOWED_PRIVATE_PEERS: 'localhost' };
    await withStubbedFetch(
      (url) =>
        url.includes('/.well-known/webfinger')
          ? webfingerResponse('http://localhost:9999/users/bob')
          : Response.json({
              id: 'http://localhost:9999/users/bob',
              type: 'Person',
              preferredUsername: 'bob',
              inbox: 'http://localhost:9999/users/bob/inbox',
            }),
      async (requests) => {
        const actor = await lookupRemoteHandleAt('bob', 'localhost:9999', env);
        assert.equal(actor?.actorUrl, 'http://localhost:9999/users/bob');
        assert.equal(requests.length, 2);
        assert.ok(requests[0].includes('localhost:9999/.well-known/webfinger'));
        assert.ok(requests.some((url) => url.startsWith('http://localhost:9999/users/bob')));
      },
    );
  });

  it('returns null when an upstream fetch throws', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;
    try {
      assert.equal(await lookupRemoteHandle('bob@example.com', REMOTE_ENV), null);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('lookup cache and rate limit', () => {
  it('caches successful lookups and reuses the cached actor', async () => {
    const { kv, store } = makeKv();
    const env: FederationEnv = { ...REMOTE_ENV, CACHE: kv };
    assert.equal(remoteLookupCacheKey('@Bob@Example.COM'), 'remote:lookup:bob@example.com');

    await withStubbedFetch(
      (url) => (url.includes('/.well-known/webfinger') ? webfingerResponse(ACTOR_URL) : actorResponse()),
      async (requests) => {
        const first = await lookupRemoteHandleCached('bob@example.com', env);
        const second = await lookupRemoteHandleCached('bob@example.com', env);
        assert.equal(first?.actorUrl, ACTOR_URL);
        assert.equal(second?.actorUrl, ACTOR_URL);
        assert.equal(requests.length, 2, 'the second lookup must come from KV');
        assert.equal(store.get('remote:lookup:bob@example.com')?.ttl, 300);
      },
    );
  });

  it('does not cache lookup failures', async () => {
    const { kv, store } = makeKv();
    const env: FederationEnv = { ...REMOTE_ENV, CACHE: kv };
    await withStubbedFetch(
      () => new Response(null, { status: 503 }),
      async (requests) => {
        assert.equal(await lookupRemoteHandleCached('bob@example.com', env), null);
        assert.equal(await lookupRemoteHandleCached('bob@example.com', env), null);
        assert.equal(requests.length, 2);
        assert.equal(store.size, 0);
      },
    );
  });

  it('throttles repeated lookups per caller', async () => {
    const { kv } = makeKv();
    const key = remoteLookupRateLimitKey('203.0.113.7');
    assert.equal(key, 'remote:lookup:rl:203.0.113.7');
    const config = { maxRequests: 15, windowSeconds: 60 };
    const results: boolean[] = [];
    for (let i = 0; i < 16; i++) results.push(await checkRateLimit(kv, key, config));
    assert.equal(results.filter(Boolean).length, 15);
    assert.equal(results[15], false);
  });
});
