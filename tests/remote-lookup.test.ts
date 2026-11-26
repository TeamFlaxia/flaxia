// Handle validation, SSRF rejection, KV caching and rate limiting for the
// remote lookup helper. All network access is stubbed; nothing leaves the test.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';
import { Hono } from 'hono';

import type { Bindings, Variables } from '../functions/api/types.ts';
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

// Route modules use Vite/Workers-style extensionless TypeScript imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.')
      ) {
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      }
      throw error;
    }
  },
});
const { social } = await import('../functions/api/routes/users/social.ts');

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

  it('rejects a WebFinger self link on another origin and never caches its actor', async () => {
    const { kv, store } = makeKv();
    const env: FederationEnv = { ...REMOTE_ENV, CACHE: kv };
    const evilActorUrl = 'https://evil.example/users/bob';
    await withStubbedFetch(
      (url) => (url.includes('/.well-known/webfinger') ? webfingerResponse(evilActorUrl) : actorResponse(evilActorUrl)),
      async (requests) => {
        assert.equal(await lookupRemoteHandleCached('bob@example.com', env), null);
        assert.equal(requests.length, 1, 'the cross-origin actor document must not be fetched');
        assert.ok(requests[0].startsWith('https://example.com/.well-known/webfinger?resource='));
        assert.equal(store.size, 0, 'an actor from another origin must not be cached under the looked-up handle');
      },
    );
  });

  it('does not let an allowlisted private peer stand in for the looked-up domain', async () => {
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
        assert.equal(await lookupRemoteHandle('bob@example.com', env), null);
        assert.equal(requests.length, 1, 'the allowlisted peer is not the domain in the handle');
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

  it('ignores and replaces a cached actor whose URL is on another origin', async () => {
    const { kv, store } = makeKv();
    const env: FederationEnv = { ...REMOTE_ENV, CACHE: kv };
    const evilActorUrl = 'https://evil.example/users/bob';
    store.set('remote:lookup:bob@example.com', {
      value: JSON.stringify({
        actorUrl: evilActorUrl,
        inbox: `${evilActorUrl}/inbox`,
        sharedInbox: null,
        publicKeyPem: null,
        preferredUsername: 'bob',
        displayName: 'Bob Example',
        iconUrl: null,
        domain: 'evil.example',
        summary: null,
      }),
    });

    await withStubbedFetch(
      (url) => (url.includes('/.well-known/webfinger') ? webfingerResponse(ACTOR_URL) : actorResponse()),
      async (requests) => {
        const actor = await lookupRemoteHandleCached('bob@example.com', env);
        assert.equal(actor?.actorUrl, ACTOR_URL, 'a cached cross-origin actor must not be served');
        assert.equal(requests.length, 2, 'the bad cache entry is ignored and the handle is resolved again');
        assert.equal(
          (JSON.parse(store.get('remote:lookup:bob@example.com')?.value ?? '{}') as { actorUrl: string }).actorUrl,
          ACTOR_URL,
          'the cache is overwritten with the verified actor',
        );
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

// The endpoint itself, mounted the same way as production: /api -> users ->
// social. `user` is injected by middleware so the rate-limit identity can be
// asserted for both guests and signed-in callers.
type SocialEnv = { Bindings: Bindings; Variables: Variables };

function lookupApp(viewer: Variables['user']): Hono<SocialEnv> {
  const app = new Hono<SocialEnv>();
  app.use('*', async (c, next) => {
    c.set('user', viewer);
    await next();
  });
  app.route('/api', social);
  return app;
}

function apiEnv(cache: KVNamespace): Bindings {
  return { BASE_URL: 'https://flaxia.app', ENVIRONMENT: 'production', CACHE: cache } as unknown as Bindings;
}

/** KV stub with a deterministic rate-limit counter (no dependence on the 60s bucket boundary). */
function makeRateLimitKv(forcedCount: number | null): {
  kv: KVNamespace;
  gets: string[];
  puts: Array<{ key: string; value: string; ttl?: number }>;
} {
  const gets: string[] = [];
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  const kv = {
    async get(key: string) {
      gets.push(key);
      return forcedCount !== null && key.startsWith('rl:') ? String(forcedCount) : null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      puts.push({ key, value, ttl: options?.expirationTtl });
    },
  } as unknown as KVNamespace;
  return { kv, gets, puts };
}

function makeBrokenKv(): KVNamespace {
  return {
    async get() {
      throw new Error('KV down');
    },
    async put() {
      throw new Error('KV down');
    },
  } as unknown as KVNamespace;
}

const SIGNED_IN_USER = { id: 'user-42', username: 'alice', display_name: 'Alice' } as Variables['user'];

describe('GET /api/remote/lookup', () => {
  it('returns 400 with the exact error for a malformed or missing handle, before touching KV or the network', async () => {
    const { kv, gets, puts } = makeRateLimitKv(0);
    const app = lookupApp(null);
    await withStubbedFetch(
      () => {
        throw new Error('unexpected fetch');
      },
      async (requests) => {
        for (const url of [
          'http://localhost/api/remote/lookup?q=bob',
          'http://localhost/api/remote/lookup?q=bob@127.0.0.1',
          'http://localhost/api/remote/lookup',
        ]) {
          const response = await app.request(url, {}, apiEnv(kv));
          assert.equal(response.status, 400, url);
          assert.deepEqual(await response.json(), { error: 'Invalid handle. Expected @user@domain' }, url);
        }
        assert.deepEqual(gets, [], 'an invalid handle must not be rate limited');
        assert.deepEqual(puts, []);
        assert.deepEqual(requests, []);
      },
    );
  });

  it('returns 429 for a guest when the IP rate-limit bucket is exhausted, without fetching', async () => {
    const { kv, gets } = makeRateLimitKv(15);
    const app = lookupApp(null);
    await withStubbedFetch(
      () => {
        throw new Error('unexpected fetch');
      },
      async (requests) => {
        const response = await app.request(
          'http://localhost/api/remote/lookup?q=%40bob%40example.com',
          { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
          apiEnv(kv),
        );
        assert.equal(response.status, 429);
        assert.deepEqual(await response.json(), { error: 'Rate limit exceeded' });
        assert.equal(gets.length, 1);
        assert.match(gets[0], /^rl:remote:lookup:rl:203\.0\.113\.7:\d+$/, 'guests are bucketed by IP');
        assert.deepEqual(requests, []);
      },
    );
  });

  it('buckets signed-in callers by user id, not by their IP', async () => {
    const { kv, gets } = makeRateLimitKv(15);
    const app = lookupApp(SIGNED_IN_USER);
    const response = await app.request(
      'http://localhost/api/remote/lookup?q=%40bob%40example.com',
      { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
      apiEnv(kv),
    );
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'Rate limit exceeded' });
    assert.equal(gets.length, 1);
    assert.match(gets[0], /^rl:remote:lookup:rl:user-42:\d+$/, 'the user id replaces the IP as identity');
  });

  it('returns 404 with the exact error when WebFinger has no resolvable actor', async () => {
    const { kv, gets, puts } = makeRateLimitKv(0);
    const app = lookupApp(null);
    await withStubbedFetch(
      () => new Response(null, { status: 503 }),
      async (requests) => {
        const response = await app.request(
          'http://localhost/api/remote/lookup?q=%40bob%40example.com',
          { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
          apiEnv(kv),
        );
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: 'Remote account not found' });
        assert.equal(response.headers.get('Cache-Control'), null);
        assert.deepEqual(requests, ['https://example.com/.well-known/webfinger?resource=acct%3Abob%40example.com']);
        assert.equal(gets.length, 2, 'one rate-limit read plus one cache read');
        assert.match(gets[0], /^rl:remote:lookup:rl:203\.0\.113\.7:\d+$/);
        assert.equal(gets[1], 'remote:lookup:bob@example.com');
        assert.deepEqual(
          puts.map((put) => put.key),
          [gets[0]],
          'only the rate-limit counter is written; a failed lookup is not cached',
        );
      },
    );
  });

  it('returns 404 for a cross-origin self link instead of serving that actor under the requested handle', async () => {
    const { kv, store } = makeKv();
    const app = lookupApp(null);
    const evilActorUrl = 'https://evil.example/users/bob';
    await withStubbedFetch(
      (url) => (url.includes('/.well-known/webfinger') ? webfingerResponse(evilActorUrl) : actorResponse(evilActorUrl)),
      async (requests) => {
        const response = await app.request(
          'http://localhost/api/remote/lookup?q=%40bob%40example.com',
          { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
          apiEnv(kv),
        );
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: 'Remote account not found' });
        assert.deepEqual(requests, ['https://example.com/.well-known/webfinger?resource=acct%3Abob%40example.com']);
        assert.equal(store.has('remote:lookup:bob@example.com'), false, 'the wrong actor is not cached');
      },
    );
  });

  it('returns 200 with the exact DTO, cache header and cached actor on success', async () => {
    const { kv, store } = makeKv();
    const app = lookupApp(null);
    await withStubbedFetch(
      (url) => (url.includes('/.well-known/webfinger') ? webfingerResponse(ACTOR_URL) : actorResponse()),
      async () => {
        const response = await app.request(
          'http://localhost/api/remote/lookup?q=%40bob%40example.com',
          { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
          apiEnv(kv),
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'private, max-age=60');
        assert.deepEqual(await response.json(), {
          handle: '@bob@example.com',
          displayName: 'Bob Example',
          avatarUrl: 'https://example.com/avatar.png',
          actorUrl: ACTOR_URL,
          domain: 'example.com',
        });
        const cached = store.get('remote:lookup:bob@example.com');
        assert.equal(cached?.ttl, 300);
        assert.equal((JSON.parse(cached?.value ?? '{}') as { actorUrl: string }).actorUrl, ACTOR_URL);
      },
    );
  });

  it('fails open when KV is down: a KV outage must not break the search box', async () => {
    // Production intent (social.ts): "Fail open matches the other public
    // lookups: a KV outage must not break the search box." checkRateLimit also
    // defaults to failureMode 'open' and the endpoint catches a thrown limiter,
    // so the lookup still runs and can succeed.
    const app = lookupApp(null);
    await withStubbedFetch(
      (url) => (url.includes('/.well-known/webfinger') ? webfingerResponse(ACTOR_URL) : actorResponse()),
      async () => {
        const response = await app.request(
          'http://localhost/api/remote/lookup?q=%40bob%40example.com',
          { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
          apiEnv(makeBrokenKv()),
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          handle: '@bob@example.com',
          displayName: 'Bob Example',
          avatarUrl: 'https://example.com/avatar.png',
          actorUrl: ACTOR_URL,
          domain: 'example.com',
        });
      },
    );
  });

  it('returns 502 with the exact error when lookup fails unexpectedly', async () => {
    // The lookup helpers turn every network/parse failure into null (404), so
    // this defensive branch is only reachable on an unexpected internal error.
    // Force one in the DTO conversion of a cached actor to exercise the real
    // catch block and its exact response body.
    const { kv, store } = makeKv();
    store.set('remote:lookup:bob@example.com', {
      value: JSON.stringify({
        actorUrl: ACTOR_URL,
        inbox: `${ACTOR_URL}/inbox`,
        sharedInbox: null,
        publicKeyPem: null,
        preferredUsername: null,
        displayName: 'Bob Example',
        iconUrl: null,
        domain: 'example.com',
        summary: null,
      }),
    });
    const app = lookupApp(null);
    const originalSplit = String.prototype.split;
    (String.prototype as unknown as { split: unknown }).split = function (
      this: string,
      ...args: [string | RegExp, number?]
    ) {
      if (this === ACTOR_URL) throw new Error('simulated internal failure');
      return originalSplit.apply(this, args);
    };
    try {
      await withStubbedFetch(
        () => {
          throw new Error('unexpected fetch');
        },
        async (requests) => {
          const response = await app.request(
            'http://localhost/api/remote/lookup?q=%40bob%40example.com',
            { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
            apiEnv(kv),
          );
          assert.equal(response.status, 502);
          assert.deepEqual(await response.json(), { error: 'Remote lookup failed' });
          assert.deepEqual(requests, [], 'the cached actor is used; no upstream fetch occurs');
        },
      );
    } finally {
      (String.prototype as unknown as { split: unknown }).split = originalSplit;
    }
  });
});
