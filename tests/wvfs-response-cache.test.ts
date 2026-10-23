import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { type TestContext, test } from 'node:test';
import { cacheWvfsResponse } from '../src/lib/wvfs-response-cache.ts';

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
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { default: worker } = await import('../src/sandbox-worker.ts');

function fixture(t: TestContext) {
  const entries = new Map<string, { body: ArrayBuffer; headers: Headers }>();
  const pending: Promise<unknown>[] = [];
  let reads = 0;
  let lookups = 0;
  let blocked = false;
  let revision = 'archive-1';
  const cache = {
    async match(request: Request) {
      lookups++;
      const entry = entries.get(request.url);
      return entry ? new Response(entry.body, { headers: entry.headers }) : undefined;
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, { body: await response.arrayBuffer(), headers: response.headers });
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: async () => cache } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else Reflect.deleteProperty(globalThis, 'caches');
  });
  const bucket = {
    async head(key: string) {
      return key.startsWith('zip/') ? { etag: revision } : null;
    },
    async get(key: string) {
      reads++;
      if (key.endsWith('/index.html')) return { text: async () => '<html><head></head><body>game</body></html>' };
      return { body: new Uint8Array([0, 97, 115, 109]) };
    },
  } as unknown as R2Bucket;
  const waitUntil = (promise: Promise<unknown>) => pending.push(promise);
  const execution = { waitUntil, passThroughOnException() {} } as unknown as ExecutionContext;
  const env = {
    BUCKET: bucket,
    DB: undefined as unknown as D1Database,
    CACHE: { get: async () => (blocked ? '1' : null) } as unknown as KVNamespace,
  };
  return {
    entries,
    cache,
    waitUntil,
    reads: () => reads,
    lookups: () => lookups,
    block: () => {
      blocked = true;
    },
    update: () => {
      revision = 'archive-2';
    },
    flush: async () => {
      await Promise.all(pending);
    },
    fetch: (path = '/api/wvfs-zip/cache-game/game.wasm', headers = {}) =>
      worker.fetch(new Request(`https://sandbox.example${path}`, { headers }), env, execution),
  };
}

test('warm asset requests skip R2 reads and keep CSP/CORS; updates get a new edge key', async (t) => {
  const f = fixture(t);
  const cold = await f.fetch();
  assert.equal(cold.headers.get('X-WVFS-Cache'), 'MISS');
  assert.equal(cold.headers.get('Cache-Control'), 'public, no-cache');
  await cold.arrayBuffer();
  await f.flush();
  const reads = f.reads();
  const warm = await f.fetch();
  assert.equal(warm.headers.get('X-WVFS-Cache'), 'HIT');
  assert.equal(f.reads(), reads);
  assert.equal(warm.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(warm.headers.get('Content-Security-Policy') ?? '', /sandbox allow-scripts/);
  assert.deepEqual(new Uint8Array(await warm.arrayBuffer()), new Uint8Array([0, 97, 115, 109]));
  f.update();
  const updated = await f.fetch();
  assert.equal(updated.headers.get('X-WVFS-Cache'), 'MISS');
  assert.notEqual(updated.headers.get('ETag'), warm.headers.get('ETag'));
  assert.ok(f.reads() > reads);
  await updated.arrayBuffer();
  await f.flush();
});

test('HTML revalidation returns 304 without rereading or rewriting HTML', async (t) => {
  const f = fixture(t);
  const path = '/api/wvfs-zip/cache-game/index.html?runtime=2';
  const cold = await f.fetch(path);
  assert.match(await cold.text(), /<base href=/);
  assert.equal(cold.headers.get('Cache-Control'), 'public, no-cache, no-transform');
  await f.flush();
  const reads = f.reads();
  const response = await f.fetch(path, { 'If-None-Match': `"other", ${cold.headers.get('ETag')}` });
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
  assert.equal(f.reads(), reads);
  assert.match(response.headers.get('Content-Security-Policy') ?? '', /sandbox allow-scripts/);
  await f.flush();
});

test('blocked payloads cannot use a warm edge entry or a browser validator', async (t) => {
  const f = fixture(t);
  const response = await f.fetch();
  await response.arrayBuffer();
  await f.flush();
  const lookups = f.lookups();
  f.block();
  const blocked = await f.fetch(undefined, { 'If-None-Match': response.headers.get('ETag')! });
  assert.equal(blocked.status, 404);
  assert.equal(f.lookups(), lookups);
});

test('cache failures fall back to delivery, and errors are never stored', async (t) => {
  const f = fixture(t);
  f.cache.match = async () => {
    throw new Error('unavailable');
  };
  f.cache.put = async () => {
    throw new Error('quota');
  };
  const response = await f.fetch();
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await f.flush();
  const identity = { postId: 'missing', filePath: 'index.html', payloadKey: 'zip/missing.zip', payloadEtag: '1' };
  const missing = await cacheWvfsResponse(
    new Request('https://sandbox.example/missing'),
    identity,
    async () => new Response('missing', { status: 404 }),
    f.waitUntil,
  );
  assert.equal(missing.status, 404);
  assert.equal(f.entries.size, 0);
});

test('only explicitly pinned asset URLs receive immutable browser caching', async (t) => {
  const f = fixture(t);
  const identity = {
    postId: 'pinned',
    filePath: 'game.js',
    versionId: 'v1',
    payloadKey: 'versions/pinned/v1.zip',
    payloadEtag: '1',
  };
  const load = async () => new Response('game', { headers: { 'Content-Type': 'application/javascript' } });
  const latest = await cacheWvfsResponse(new Request('https://sandbox.example/game.js'), identity, load, f.waitUntil);
  assert.equal(latest.headers.get('Cache-Control'), 'public, no-cache');
  await latest.text();
  await f.flush();
  const pinned = await cacheWvfsResponse(
    new Request('https://sandbox.example/game.js?v=v1'),
    identity,
    load,
    f.waitUntil,
  );
  assert.match(pinned.headers.get('Cache-Control') ?? '', /immutable/);
  assert.equal(pinned.headers.get('X-WVFS-Cache'), 'HIT');
  await pinned.text();
});

test('without the Cache API or a source ETag the loader still works', async (t) => {
  const f = fixture(t);
  Reflect.deleteProperty(globalThis, 'caches');
  const identity = { postId: 'local', filePath: 'game.js', payloadKey: 'zip/local.zip', payloadEtag: '1' };
  const load = async () => new Response('game');
  const local = await cacheWvfsResponse(new Request('https://sandbox.example/game.js'), identity, load, f.waitUntil);
  assert.equal(await local.text(), 'game');
  const unknown = await cacheWvfsResponse(
    new Request('https://sandbox.example/game.js'),
    { ...identity, payloadEtag: undefined },
    load,
    f.waitUntil,
  );
  assert.equal(unknown.headers.get('ETag'), null);
  assert.equal(await unknown.text(), 'game');
});
