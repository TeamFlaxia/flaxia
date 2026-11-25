import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { introspectAuthGrant, revokeAuthGrant } from '../functions/lib/flaxia-auth.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const HOT_ROUTES = [
  'functions/api/routes/posts/feed.ts',
  'functions/api/routes/posts/replies.ts',
  'functions/api/routes/users/profiles.ts',
  'functions/api/routes/games.ts',
];

test('hot handlers reuse the user resolved by authMiddleware instead of re-resolving the session', () => {
  for (const path of HOT_ROUTES) {
    const source = read(path);
    assert.ok(
      !source.includes('getMeWithSession('),
      `${path} still calls getMeWithSession() a second time after authMiddleware`,
    );
    assert.ok(source.includes("c.get('user')"), `${path} does not read the middleware user from c.get('user')`);
  }
});

test('the fallback resolver lives in the shared helpers, not in the hot handlers', () => {
  const helpers = read('functions/api/helpers.ts');
  assert.ok(/resolveRequestUser\s*\(/.test(helpers), 'helpers.ts must export a fallback resolver');
  assert.ok(/getMeWithSession\s*\(/.test(helpers), 'only helpers.ts may call getMeWithSession as a fallback');
  for (const path of HOT_ROUTES) {
    assert.ok(/resolveRequestUser\s*\(/.test(read(path)), `${path} must use the shared fallback resolver`);
  }
});

test('auth introspection has a bounded, short-lived in-isolate cache', () => {
  const cacheSource =
    read('functions/lib/auth.ts') +
    read('functions/lib/flaxia-auth.ts') +
    read('functions/lib/auth-introspection-cache.ts');
  const expectations: Array<[RegExp, string]> = [
    [/new Map\(/, 'a Map-based introspection cache is required'],
    [/30_000/, 'the cache TTL must be short (~30s)'],
    [/TTL/i, 'the cache must have an explicit TTL'],
    [/MAX/i, 'the cache must be bounded'],
    [/crypto\.subtle\.digest/, 'grant tokens must be hashed before use as a cache key'],
  ];
  for (const [pattern, message] of expectations) {
    assert.ok(pattern.test(cacheSource), message);
  }
});

function countingService(grant: string, status = 200) {
  let introspections = 0;
  const fetcher = {
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === '/api/flaxia/introspect') introspections++;
      return Response.json(
        status === 200
          ? { user_id: 'cached-user', expires_at: new Date(Date.now() + 60_000).toISOString() }
          : { error: 'unauthorized' },
        { status },
      );
    },
  } as unknown as Fetcher;
  return { env: { AUTH_SERVICE: fetcher, grant }, calls: () => introspections };
}

test('a successful introspection is reused for the same grant within the TTL', async () => {
  const grant = 'b'.repeat(43);
  const { env, calls } = countingService(grant);
  const first = await introspectAuthGrant(env, grant);
  const second = await introspectAuthGrant(env, grant);
  assert.deepEqual(second, first);
  assert.ok(first);
  assert.equal(calls(), 1, 'the second introspection must hit the in-isolate cache');
});

test('rejections are never cached, and revocation forgets a cached success', async () => {
  const rejected = 'c'.repeat(43);
  let attempts = 0;
  const service = {
    fetch: async () => {
      attempts++;
      return attempts === 1
        ? new Response(null, { status: 401 })
        : Response.json({ user_id: 'cached-user', expires_at: new Date(Date.now() + 60_000).toISOString() });
    },
  } as unknown as Fetcher;
  const env = { AUTH_SERVICE: service };
  assert.equal(await introspectAuthGrant(env, rejected), null);
  assert.ok(await introspectAuthGrant(env, rejected), 'a fresh check must not reuse the rejection');
  assert.equal(attempts, 2);

  const revokedGrant = 'd'.repeat(43);
  const mocked = countingService(revokedGrant);
  await introspectAuthGrant(mocked.env, revokedGrant);
  await revokeAuthGrant(mocked.env, revokedGrant);
  await introspectAuthGrant(mocked.env, revokedGrant);
  assert.equal(mocked.calls(), 2, 'revocation must invalidate the cached success');
});
