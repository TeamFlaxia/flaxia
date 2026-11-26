// SSR subresponses need a short private max-age so SvelteKit serializes a
// `data-ttl` script and seeds its client fetch cache during hydration. Later
// client navigations are then served from memory with zero network requests.
// Only public, allowlisted GETs may opt in — viewer-specific API data must keep
// the policy set by the public API handlers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { handleFetch } from '../src/hooks.server.ts';

type HookInput = Parameters<typeof handleFetch>[0];

const API_ORIGIN = 'https://flaxia.app';

interface HookOptions {
  method?: string;
  pageUrl?: string;
  response?: Response;
}

async function runHook(url: string, options: HookOptions = {}) {
  const request = new Request(url, { method: options.method ?? 'GET' });
  const original =
    options.response ??
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
        'x-api-handler': 'kept',
      },
    });
  const seen: Request[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    seen.push(input instanceof Request ? input : new Request(input));
    return original;
  };
  const event = { url: new URL(options.pageUrl ?? `${API_ORIGIN}/home`) } as HookInput['event'];
  const response = await handleFetch({ event, request, fetch: fetchImpl });
  return { response, original, seen };
}

const ALLOWED_GETS = [
  '/api/posts',
  '/api/posts?limit=20',
  '/api/posts?limit=20&username=alice',
  '/api/posts/recommended',
  '/api/posts/p123/thread',
  '/api/posts/p123/replies',
  '/api/users/alice',
  '/api/games',
  '/api/games?limit=30',
];

test('hooks.server.ts exports a handleFetch hook', () => {
  assert.equal(typeof handleFetch, 'function');
});

test('allowlisted GET subresponses get only a private 10s max-age', async () => {
  for (const path of ALLOWED_GETS) {
    const upstream = new Response('payload', {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60, s-maxage=120',
        'x-api-handler': 'kept',
        vary: 'Accept-Language',
      },
    });
    const { response, original, seen } = await runHook(`${API_ORIGIN}${path}`, { response: upstream });

    assert.equal(
      response.headers.get('cache-control'),
      'private, max-age=10',
      `${path} must advertise exactly a private 10s browser cache`,
    );
    assert.doesNotMatch(response.headers.get('cache-control') ?? '', /s-maxage/, `${path} must not invite CDN caching`);
    assert.equal(response.headers.get('x-api-handler'), 'kept', `${path} must keep upstream headers`);
    assert.equal(response.headers.get('content-type'), 'application/json', `${path} must keep upstream headers`);
    assert.equal(response.headers.get('vary'), 'Accept-Language', `${path} must keep upstream headers`);
    assert.notEqual(response, original, `${path} hook must clone instead of mutating the API response`);
    assert.equal(
      original.headers.get('cache-control'),
      'public, max-age=60, s-maxage=120',
      `${path} public API handler headers must stay untouched`,
    );
    assert.equal(seen.length, 1, `${path} must be fetched exactly once`);
    assert.equal(seen[0]?.url, `${API_ORIGIN}${path}`, `${path} must forward the original request`);
  }
});

test('the hook preserves status, statusText, and body for cached subresponses', async () => {
  for (const status of [200, 404, 503]) {
    const body = JSON.stringify({ status });
    const upstream = new Response(body, {
      status,
      statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Service Unavailable',
      headers: { 'content-type': 'application/json', 'x-api-handler': 'kept' },
    });
    const { response } = await runHook(`${API_ORIGIN}/api/posts/p123/thread`, { response: upstream });

    assert.equal(response.status, status);
    assert.equal(response.statusText, upstream.statusText);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get('cache-control'), 'private, max-age=10');
    assert.equal(response.headers.get('x-api-handler'), 'kept');
  }
});

test('a bodyless cached subresponse stays bodyless', async () => {
  const upstream = new Response(null, { status: 204, statusText: 'No Content' });
  const { response } = await runHook(`${API_ORIGIN}/api/games`, { response: upstream });

  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('cache-control'), 'private, max-age=10');
});

test('non-allowlisted GET subresponses are returned untouched', async () => {
  const paths = [
    '/api/me',
    '/api/auth/session',
    '/api/vault/items',
    '/api/admin/stats',
    '/api/notifications',
    '/api/billing/checkout',
    '/api/posts/p123',
    '/api/posts/p123/reactions',
    '/api/users/alice/followers',
    '/api/actors/alice/inbox',
    '/locales/en.json',
    '/home',
  ];
  for (const path of paths) {
    const upstream = new Response('viewer-specific', {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    });
    const { response, original, seen } = await runHook(`${API_ORIGIN}${path}`, { response: upstream });

    assert.equal(response, original, `${path} must not be reconstructed`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', `${path} must keep its own policy`);
    assert.equal(await response.text(), 'viewer-specific');
    assert.equal(seen.length, 1);
  }
});

test('an allowlisted path with no cache policy stays untouched when it is not a GET', async () => {
  const cases: Array<[string, string]> = [
    ['POST', '/api/posts'],
    ['PUT', '/api/users/alice'],
    ['PATCH', '/api/posts/p123/thread'],
    ['DELETE', '/api/posts/p123/replies'],
    ['HEAD', '/api/games'],
  ];
  for (const [method, path] of cases) {
    const upstream = new Response(null, { status: 200, headers: { 'x-api-handler': 'kept' } });
    const { response, original } = await runHook(`${API_ORIGIN}${path}`, { method, response: upstream });

    assert.equal(response, original, `${method} ${path} must not be reconstructed`);
    assert.equal(response.headers.get('cache-control'), null, `${method} ${path} must gain no cache policy`);
    assert.equal(response.headers.get('x-api-handler'), 'kept');
  }
});

test('cross-origin subresponses are never cached even with an allowlisted path', async () => {
  for (const url of ['https://sandbox.flaxia.app/api/posts', 'https://evil.example/api/users/alice']) {
    const upstream = new Response('{}', { headers: { 'content-type': 'application/json' } });
    const { response, original } = await runHook(url, { response: upstream });

    assert.equal(response, original, `${url} must not be reconstructed`);
    assert.equal(response.headers.get('cache-control'), null, `${url} must gain no cache policy`);
  }
});

test('same-origin is resolved against the current page origin, not a hard-coded host', async () => {
  const localPage = { pageUrl: 'http://localhost:5173/home' };
  const local = await runHook('http://localhost:5173/api/posts', localPage);
  assert.equal(local.response.headers.get('cache-control'), 'private, max-age=10');

  const remote = await runHook(`${API_ORIGIN}/api/posts`, localPage);
  assert.equal(remote.response, remote.original, 'another origin must stay untouched');
  assert.equal(remote.response.headers.get('cache-control'), remote.original.headers.get('cache-control'));
});

test('source keeps the cache policy narrow and never advertises s-maxage', async () => {
  const source = await readFile(new URL('../src/hooks.server.ts', import.meta.url), 'utf8');

  assert.match(source, /export const handleFetch: HandleFetch/);
  assert.match(source, /request\.method/, 'only GET subrequests may be cached');
  assert.match(source, /url\.origin/, 'cross-origin subrequests must be excluded');
  assert.match(source, /new Headers\(response\.headers\)/, 'cache changes must not mutate the API response');
  assert.match(source, /['"]private, max-age=10['"]/, 'the TTL must match CLIENT_CACHE_TTL');
  assert.doesNotMatch(source, /s-maxage/, 'shared caches must never see a TTL');
});

test('SvelteKit serializes max-age responses and seeds its client cache', async () => {
  const serialize = await readFile(
    new URL('../node_modules/@sveltejs/kit/src/runtime/server/page/serialize_data.js', import.meta.url),
    'utf8',
  );
  const fetcher = await readFile(
    new URL('../node_modules/@sveltejs/kit/src/runtime/client/fetcher.js', import.meta.url),
    'utf8',
  );

  assert.match(serialize, /data-ttl/);
  assert.match(serialize, /max-age=\(\\d\+\)/);
  assert.match(fetcher, /initial_fetch/);
  assert.match(fetcher, /cache\.set\(selector/);
});
