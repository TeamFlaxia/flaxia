// The auth hot path must stay cheap without weakening DM privacy or turning a
// network hiccup into a sign-out. Source guards cover the edge-side middleware
// and the recovery chain; the client cache and the Hono middleware are exercised
// behaviourally.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { afterEach, test } from 'node:test';
import { clearMeCache, getMe } from '../src/lib/auth-cache.ts';
import { getSessionUser, loadSessionUser } from '../src/lib/svelte/session.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/** Prose may mention the old probe; only executable code matters here. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Extract a function body by matching braces outside strings and comments. */
function functionBody(source: string, signature: RegExp): string {
  const match = signature.exec(source);
  assert.ok(match, `missing function matching ${signature}`);
  // All targeted signatures are single-line; the last `{` on the line is the
  // body (earlier ones may belong to generic types such as Context<{ ... }>).
  const lineEnd = source.indexOf('\n', match.index);
  const open = source.lastIndexOf('{', lineEnd);
  assert.ok(open > match.index, 'function has no body');
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return source.slice(open, i + 1);
    }
  }
  assert.fail('unbalanced braces');
}

// helpers.ts uses extensionless relative imports for the Worker bundler; Node
// needs a tiny resolver shim to load the same module for the behavioural test.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
}
`),
);

test('public media GETs set an explicit null user and never resolve a session', () => {
  const middleware = functionBody(read('functions/api/helpers.ts'), /export const authMiddleware = async \(/);
  const branch = middleware.match(/if \(skipsSession\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  assert.ok(branch, 'the skipsSession branch must be discoverable');
  assert.match(branch, /c\.set\('user', null\)/, 'public GETs must explicitly clear the middleware user');
  assert.doesNotMatch(branch, /getMeWithSession/, 'public GETs must not look up the session');
  assert.doesNotMatch(branch, /if \(token\)/, 'the null assignment must be unconditional');

  const condition = middleware.match(/const skipsSession =([\s\S]*?);/)?.[1] ?? '';
  assert.match(middleware, /path\.includes\('\/dm\/'\)/, 'DM media must be detected by the middleware');
  assert.match(condition, /!isDmMedia/, 'DM media must be excluded from the public fast path');
});

test('grant recovery scans run together on the authenticated hot path', () => {
  const resolver = functionBody(read('functions/lib/auth.ts'), /export async function getMeWithSession\(/);
  const parallel = resolver.match(/await Promise\.all\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  assert.ok(parallel, 'both independent recovery scans must share one Promise.all');
  assert.match(parallel, /recoverDirectCredentialChange\(/);
  assert.match(parallel, /recoverDirectEmail\(/);
  assert.equal(
    (resolver.match(/recoverDirectCredentialChange\(/g) ?? []).length,
    1,
    'credential recovery must not also run sequentially',
  );
  assert.equal(
    (resolver.match(/recoverDirectEmail\(/g) ?? []).length,
    1,
    'email recovery must not also run sequentially',
  );
});

test('native boot does not probe /api/me but still detects connectivity', () => {
  const source = stripComments(read('src/lib/svelte/bootstrap.ts'));
  assert.doesNotMatch(source, /\/api\/me/, 'the bootstrap must not send a second auth-chain request');
  assert.doesNotMatch(source, /no-store/, 'the removed probe must not bypass auth-cache');
  assert.doesNotMatch(source, /probeConnectivity/, 'the connectivity probe must be gone');
  const boot = functionBody(source, /export function initShellBootstrap\(\)/);
  assert.match(boot, /navigator\.onLine/, 'offline detection must still use navigator.onLine');
  assert.match(boot, /createOfflineFetch\(/, 'the offline fetch wrapper must remain installed');
});

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  clearMeCache();
});

/** Push the 5-minute auth-cache TTL into the past so the next call re-fetches. */
function expireAuthCache(): void {
  Date.now = () => originalNow() + 6 * 60 * 1000;
}

test('a network failure keeps a known user and its session snapshot', async () => {
  clearMeCache();
  globalThis.fetch = async () => Response.json({ user: { id: 'alice' } });
  await loadSessionUser();
  assert.equal(getSessionUser()?.id, 'alice');
  expireAuthCache();

  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  assert.deepEqual(await getMe(), { user: { id: 'alice' } });
  await loadSessionUser();
  assert.equal(getSessionUser()?.id, 'alice', 'a transient error must not sign the user out');

  globalThis.fetch = async () => new Response('', { status: 503 });
  await loadSessionUser();
  assert.equal(getSessionUser()?.id, 'alice', 'a transient HTTP error must not sign the user out');
});

test('an explicit 401 still clears the cached user and the session snapshot', async () => {
  clearMeCache();
  globalThis.fetch = async () => Response.json({ user: { id: 'bob' } });
  await loadSessionUser();
  assert.equal(getSessionUser()?.id, 'bob');
  expireAuthCache();

  globalThis.fetch = async () => new Response('', { status: 401 });
  await loadSessionUser();
  assert.equal(getSessionUser(), null);
  assert.equal(await getMe(), null);
});

test('only an explicit 401 may clear the auth cache', () => {
  const source = read('src/lib/auth-cache.ts');
  const getMeBody = functionBody(source, /export async function getMe\(/);
  assert.match(getMeBody, /status === 401/, '401 handling must stay explicit');
  assert.equal(
    (getMeBody.match(/clearMeCache\(\)/g) ?? []).length,
    1,
    'clearMeCache must only be called from the 401 branch',
  );
  const catchBlock = getMeBody.match(/\.catch\(\(\) => \{([\s\S]*?)\}\)/)?.[1] ?? '';
  assert.ok(catchBlock, 'the network-error handler must be discoverable');
  assert.match(catchBlock, /cachedMe/, 'a network error must keep the last known user');
  assert.doesNotMatch(catchBlock, /null/, 'a network error must not clear a signed-in user');
});

test('authMiddleware resolves a session for DM media but not for public media', async () => {
  const { Hono } = await import('hono');
  const { authMiddleware } = await import('../functions/api/helpers.ts');

  const app = new Hono();
  app.use('*', authMiddleware);
  app.get('/api/images/:key', (c) => c.json({ user: c.get('user') ?? 'unset' }));
  app.get('/api/images/dm/:key', (c) => c.json({ user: c.get('user') ?? 'unset' }));

  let dbLookups = 0;
  const env = {
    DB: {
      prepare: () => {
        dbLookups++;
        throw new Error('unexpected session lookup');
      },
    },
  } as never;
  const cookie = { Cookie: 'session=test-token' };

  const publicRes = await app.request('/api/images/public.png', { headers: cookie }, env);
  assert.equal(publicRes.status, 200);
  assert.deepEqual(await publicRes.json(), { user: 'unset' }, 'public media must see a null user');
  assert.equal(dbLookups, 0, 'public media must not touch the session store');

  dbLookups = 0;
  const dmRes = await app.request('/api/images/dm/private.png', { headers: cookie }, env);
  assert.equal(dmRes.status, 500, 'DM media must still attempt session resolution');
  assert.ok(dbLookups > 0, 'DM media must resolve the session cookie');
});
