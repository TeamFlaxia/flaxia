import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

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

const execution = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;
const customMetadata = { 'wvfs-source-key': 'zip/policy-game.zip', 'wvfs-source-etag': 'archive-1' };
const scanCache = { get: async () => null } as unknown as KVNamespace;

test('game HTML revalidates, prevents edge injection, and retains opaque sandbox CSP', async () => {
  // Use the worker's fallback WVFS asset path with an already extracted file.
  const bucket = {
    async head(key: string) {
      return key === 'zip/policy-game.zip' ? { etag: 'archive-1' } : null;
    },
    async get(key: string) {
      if (key !== 'wvfs/policy-game/index.html') return null;
      return { customMetadata, text: async () => '<html><head></head><body>game</body></html>' };
    },
  } as unknown as R2Bucket;
  const response = await worker.fetch(
    new Request('https://sandbox.example/index.html', {
      headers: { Referer: 'https://sandbox.example/api/wvfs-zip/policy-game/' },
    }),
    { BUCKET: bucket, DB: undefined as unknown as D1Database, CACHE: scanCache },
    execution,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'public, no-cache, no-transform');
  const csp = response.headers.get('Content-Security-Policy') ?? '';
  assert.match(csp, /sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(await response.text(), /Object\.defineProperty\(document,"cookie"/);
});

test('trusted storage HTML prevents edge injection while preserving no-store and its CSP', async () => {
  const response = await worker.fetch(
    new Request('https://sandbox.example/api/game-storage'),
    { BUCKET: {} as R2Bucket, DB: {} as D1Database },
    execution,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store, no-transform');
  assert.match(response.headers.get('Content-Security-Policy') ?? '', /default-src 'none'/);
});

test('unpinned root game assets revalidate and retain CORS', async () => {
  const bucket = {
    async head(key: string) {
      return key === 'zip/policy-game.zip' ? { etag: 'archive-1' } : null;
    },
    async get() {
      return { customMetadata, body: new Uint8Array([0, 97, 115, 109]) };
    },
  } as unknown as R2Bucket;
  const response = await worker.fetch(
    new Request('https://sandbox.example/game.wasm', {
      headers: { Referer: 'https://sandbox.example/api/wvfs-zip/policy-game/' },
    }),
    { BUCKET: bucket, DB: undefined as unknown as D1Database, CACHE: scanCache },
    execution,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'public, no-cache');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 97, 115, 109]));
});
