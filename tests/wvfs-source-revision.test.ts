import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { type TestContext, test } from 'node:test';
import JSZip from 'jszip';
import { extractZipToR2 } from '../src/lib/wvfs-zip-server.ts';

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

function fixture(t: TestContext, postId: string) {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string> }>();
  const entries = new Map<string, { bytes: ArrayBuffer; headers: Headers }>();
  const pending: Promise<unknown>[] = [];
  let sequence = 0;
  let reads = 0;
  let sourceKey = `zip/${postId}.zip`;
  let beforeSourceRead: (() => Promise<void>) | undefined;
  const bucket = {
    async head(key: string) {
      const entry = objects.get(key);
      return entry ? { size: entry.bytes.length, etag: entry.etag } : null;
    },
    async get(
      key: string,
      options?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } },
    ) {
      reads++;
      if (key === sourceKey && beforeSourceRead) {
        const callback = beforeSourceRead;
        beforeSourceRead = undefined;
        await callback();
      }
      const entry = objects.get(key);
      if (!entry) return null;
      const metadata = { etag: entry.etag, customMetadata: entry.customMetadata };
      if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== entry.etag) return metadata;
      const range = options?.range;
      const bytes = range ? entry.bytes.slice(range.offset, range.offset + range.length) : entry.bytes.slice();
      return {
        ...metadata,
        body: bytes,
        arrayBuffer: async () => bytes.buffer,
        text: async () => new TextDecoder().decode(bytes),
      };
    },
    async put(key: string, body: Uint8Array | ArrayBuffer | string, options?: R2PutOptions) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
      objects.set(key, { bytes, etag: String(++sequence), customMetadata: options?.customMetadata ?? {} });
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async () => ({
        async match(request: Request) {
          const entry = entries.get(request.url);
          return entry ? new Response(entry.bytes, { headers: entry.headers }) : undefined;
        },
        async put(request: Request, response: Response) {
          entries.set(request.url, { bytes: await response.arrayBuffer(), headers: response.headers });
        },
      }),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else Reflect.deleteProperty(globalThis, 'caches');
  });
  const env = {
    BUCKET: bucket as unknown as R2Bucket,
    DB: undefined as unknown as D1Database,
    CACHE: { get: async () => null } as unknown as KVNamespace,
  };
  const execution = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return {
    objects,
    entries,
    reads: () => reads,
    beforeSourceRead(callback: () => Promise<void>) {
      beforeSourceRead = callback;
    },
    async zip(files: Record<string, string>) {
      const zip = new JSZip();
      for (const [name, content] of Object.entries(files)) zip.file(name, content);
      await bucket.put(sourceKey, await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    },
    async html(content: string) {
      sourceKey = `html/${postId}.html`;
      await bucket.put(sourceKey, content);
    },
    prime: () => extractZipToR2(env.BUCKET, sourceKey, postId),
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
    fetch: (file: string, headers = {}) =>
      worker.fetch(new Request(`https://sandbox.example/api/wvfs-zip/${postId}/${file}`, { headers }), env, execution),
  };
}

test('a replaced ZIP cannot populate its new edge entry with old extracted bytes', async (t) => {
  const f = fixture(t, 'revision-r2');
  await f.zip({ 'index.html': '<html>old</html>', 'game.js': 'old', 'removed.js': 'removed' });
  await f.prime();
  const old = await f.fetch('game.js');
  assert.equal(await old.text(), 'old');
  await f.flush();
  await f.zip({ 'index.html': '<html>new</html>', 'game.js': 'new' });
  const updated = await f.fetch('game.js', { 'If-None-Match': old.headers.get('ETag')! });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.headers.get('ETag'), old.headers.get('ETag'));
  assert.equal(await updated.text(), 'new');
  await f.flush();
  const reads = f.reads();
  const warm = await f.fetch('game.js');
  assert.equal(warm.headers.get('X-WVFS-Cache'), 'HIT');
  assert.equal(await warm.text(), 'new');
  assert.equal(f.reads(), reads);
  const removed = await f.fetch('removed.js');
  assert.equal(removed.status, 404);
  await f.flush();
});

test('in-memory files and rewritten HTML are isolated by the source revision', async (t) => {
  const f = fixture(t, 'revision-memory');
  await f.zip({ 'index.html': '<html><head></head><body>old document</body></html>', 'game.js': 'old script' });
  assert.equal(await (await f.fetch('game.js')).text(), 'old script');
  assert.match(await (await f.fetch('index.html')).text(), /old document/);
  await f.flush();
  f.entries.clear();
  for (const key of f.objects.keys()) if (key.startsWith('wvfs/')) f.objects.delete(key);
  await f.zip({ 'index.html': '<html><head></head><body>new document</body></html>', 'game.js': 'new script' });
  assert.equal(await (await f.fetch('game.js')).text(), 'new script');
  assert.match(await (await f.fetch('index.html')).text(), /new document/);
  await f.flush();
});

test('background extraction resumes only the matching source manifest', async (t) => {
  const f = fixture(t, 'revision-background');
  await f.zip({ 'index.html': '<html><head></head><body>old document</body></html>' });
  assert.equal(await f.prime(), 1);
  assert.match(await (await f.fetch('index.html')).text(), /old document/);
  await f.flush();
  await f.zip({ 'index.html': '<html><head></head><body>new document</body></html>' });
  assert.equal(await f.prime(), 1);
  assert.match(await (await f.fetch('index.html')).text(), /new document/);
  assert.equal(await f.prime(), 0);
  await f.flush();
});

test('replacing a direct HTML upload refreshes both copied and rewritten content', async (t) => {
  const f = fixture(t, 'revision-html');
  await f.html('<html><head></head><body>old document</body></html>');
  assert.match(await (await f.fetch('index.html')).text(), /old document/);
  await f.flush();
  await f.html('<html><head></head><body>new document</body></html>');
  assert.match(await (await f.fetch('index.html')).text(), /new document/);
  await f.flush();
});

test('a ZIP replaced between head and range reads cannot be cached under the old validator', async (t) => {
  const f = fixture(t, 'revision-zip-race');
  await f.zip({ 'index.html': '<html>old</html>', 'game.js': 'old' });
  f.beforeSourceRead(() => f.zip({ 'index.html': '<html>new</html>', 'game.js': 'new' }));
  const interrupted = await f.fetch('game.js');
  assert.equal(interrupted.status, 404);
  await f.flush();
  assert.equal(f.entries.size, 0);
  assert.equal(await (await f.fetch('game.js')).text(), 'new');
  await f.flush();
});

test('HTML replaced after head cannot be cached under the old validator', async (t) => {
  const f = fixture(t, 'revision-html-race');
  await f.html('<html>old</html>');
  f.beforeSourceRead(() => f.html('<html>new</html>'));
  const interrupted = await f.fetch('index.html');
  assert.equal(interrupted.status, 404);
  await f.flush();
  assert.equal(f.entries.size, 0);
  assert.match(await (await f.fetch('index.html')).text(), /<html>new<\/html>/);
  await f.flush();
});
