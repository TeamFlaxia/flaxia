import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Hono } from 'hono';
import { readArchive, writeArchive } from '../sandbox/game-loader/cache.js';
import { resolvePath, validateFiles, validatePath } from '../sandbox/game-loader/protocol.js';
import { serveGameLoaderAsset } from '../src/lib/game-loader-routes.ts';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const files = [
  { path: 'index.html', bytes: bytes('<html>game</html>') },
  { path: 'data.json', bytes: bytes('{}') },
];
const HASH = 'a'.repeat(64);

function memoryStorage() {
  const stores = new Map<string, Map<string, { bytes: ArrayBuffer; headers: Headers }>>();
  let failAfter = Infinity;
  return {
    stores,
    failAfter: (value: number) => {
      failAfter = value;
    },
    has: async (name: string) => stores.has(name),
    delete: async (name: string) => stores.delete(name),
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name)!;
      return {
        async match(key: string) {
          const stored = entries.get(key);
          return stored ? new Response(stored.bytes, { headers: stored.headers }) : undefined;
        },
        async put(key: string, response: Response) {
          if (--failAfter < 0) throw new Error('Quota exceeded');
          entries.set(key, { bytes: await response.arrayBuffer(), headers: response.headers });
        },
      };
    },
  };
}

test('cache persists complete expanded files and isolates archive revisions', async () => {
  const storage = memoryStorage();
  assert.equal(await readArchive(storage, 'https://sandbox.example', HASH), null);
  await writeArchive(storage, 'https://sandbox.example', HASH, files);
  const restored = await readArchive(storage, 'https://sandbox.example', HASH);
  assert.equal(restored?.entry, 'index.html');
  assert.equal(new TextDecoder().decode(restored?.files[0].bytes), '<html>game</html>');
  assert.equal(await readArchive(storage, 'https://sandbox.example', 'b'.repeat(64)), null);
});

test('interrupted cache writes are rolled back; missing files invalidate a completed archive', async () => {
  const storage = memoryStorage();
  storage.failAfter(1);
  await assert.rejects(writeArchive(storage, 'https://sandbox.example', HASH, files), /Quota/);
  assert.equal(storage.stores.size, 0);
  storage.failAfter(Infinity);
  await writeArchive(storage, 'https://sandbox.example', HASH, files);
  const entries = [...storage.stores.values()][0];
  entries.delete([...entries.keys()].find((key) => key.endsWith('/data.json'))!);
  assert.equal(await readArchive(storage, 'https://sandbox.example', HASH), null);
  assert.equal(storage.stores.size, 0);
});

test('archive validation rejects traversal, duplicate files, unsupported types and missing entry points', () => {
  for (const path of [
    '/index.html',
    '../game.js',
    'a/../game.js',
    'a\\game.js',
    'a//game.js',
    'a%2fgame.js',
    'a\0.js',
  ]) {
    assert.equal(validatePath(path), false, path);
  }
  assert.throws(() => validateFiles([...files, files[0]]), /Invalid/);
  assert.throws(() => validateFiles([{ path: 'game.exe', bytes: bytes('x') }]), /Invalid/);
  assert.throws(() => validateFiles([{ path: 'game.js', bytes: bytes('x') }]), /No index/);
  assert.equal(validateFiles([{ path: 'game/index.html', bytes: bytes('x') }]), 'game/index.html');
  assert.deepEqual(resolvePath('../data.json?v=1', 'game/index.html'), { path: 'data.json', suffix: '' });
  assert.equal(resolvePath('https://external.example/game.js', 'index.html'), null);
});

test('HTTP shell keeps uploaded code opaque and loader code has a separate strict CSP', async () => {
  const app = new Hono<{ Bindings: { ASSETS: { fetch: (request: Request) => Promise<Response> } } }>();
  app.get('/game-loader/*', (c) => serveGameLoaderAsset(c));
  const env = { ASSETS: { fetch: async () => new Response('static asset') } };
  const shell = await app.request('https://sandbox.example/game-loader/game-shell.html', {}, env);
  assert.match(shell.headers.get('Content-Security-Policy') ?? '', /sandbox allow-scripts/);
  assert.doesNotMatch(shell.headers.get('Content-Security-Policy') ?? '', /allow-same-origin/);
  assert.match(shell.headers.get('Content-Security-Policy') ?? '', /connect-src blob: data:/);
  const loader = await app.request('https://sandbox.example/game-loader/prototype', {}, env);
  assert.match(loader.headers.get('Content-Security-Policy') ?? '', /script-src 'self';/);
  assert.doesNotMatch(loader.headers.get('Content-Security-Policy') ?? '', /unsafe-inline|unsafe-eval|sandbox allow/);
  assert.equal((await app.request('https://sandbox.example/game-loader/cache/files/index.html', {}, env)).status, 404);
  const sw = await app.request('https://sandbox.example/game-loader/sw.js', {}, env);
  assert.equal(sw.headers.get('Service-Worker-Allowed'), '/game-loader/');
  assert.match(sw.headers.get('Content-Type') ?? '', /text\/javascript/);
});

test('prototype SW accepts only trusted loader clients and never serves archive bytes through fetch', async () => {
  const sw = await readFile(new URL('../sandbox/game-loader/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /clients\.get/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.doesNotMatch(sw, /addEventListener\(['"]fetch/);
  const source = await readFile(new URL('../sandbox/game-loader/prototype.js', import.meta.url), 'utf8');
  assert.match(source, /event\.source !== iframe\.contentWindow/);
  assert.match(source, /event\.origin !== 'null'/);
  assert.doesNotMatch(source, /allow-same-origin/);
});
