// Optional real-browser checks: see docs/game-loader-prototype.md.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Hono } from 'hono';
import JSZip from 'jszip';
import { servePublicLoader } from '../src/lib/game-loader-public.ts';
import { serveGameLoaderAsset } from '../src/lib/game-loader-routes.ts';

const { chromium, firefox, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const engine = { chromium, firefox, webkit }[process.env.LOADER_BROWSER ?? 'chromium'];

async function fixtureZip() {
  const zip = new JSZip();
  zip.file(
    'game/index.html',
    '<html><head><link rel="stylesheet" href="styles/main.css"></head><body><img id="static-image" src="image.png"><audio id="audio" src="sound.wav" preload="auto"></audio><script src="scripts/game.js"></script></body></html>',
  );
  zip.file(
    'game/styles/main.css',
    '@import "other.css"; body { background-image: url("../image.png"); color: rgb(12, 34, 56); }',
  );
  zip.file('game/styles/other.css', 'body { margin: 7px; }');
  zip.file('game/data.json', '{"value":42}');
  zip.file(
    'game/image.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const wav = Buffer.alloc(204);
  wav.write('RIFF');
  wav.writeUInt32LE(196, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(160, 40);
  zip.file('game/sound.wav', wav);
  zip.file(
    'game/answer.wasm',
    Uint8Array.from([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
      10, 6, 1, 4, 0, 65, 42, 11,
    ]),
  );
  zip.file(
    'game/scripts/game.js',
    `
    (async () => {
      const data = await (await fetch('data.json?cache-bust=1')).json();
      const wasm = await WebAssembly.instantiateStreaming(fetch('answer.wasm'));
      const xhr = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest(); request.open('GET', 'data.json');
        request.onload = () => resolve(JSON.parse(request.responseText).value); request.onerror = reject; request.send();
      });
      const image = new Image(); image.src = 'image.png'; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      canvas.getContext('2d').drawImage(image, 0, 0); const canvasReadable = canvas.toDataURL().startsWith('data:image/png');
      const audio = document.getElementById('audio');
      if (!audio.readyState) await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = () => reject(new Error('Audio failed')); });
      let storageBlocked = false, parentBlocked = false, swBlocked = false;
      try { localStorage.getItem('test'); } catch { storageBlocked = true; }
      try { window.parent.document.body; } catch { parentBlocked = true; }
      try { swBlocked = !navigator.serviceWorker; } catch { swBlocked = true; }
      document.body.dataset.result = JSON.stringify({ value: data.value, wasm: wasm.instance.exports.answer(), xhr, image: image.width, canvasReadable, audio: audio.duration > 0, storageBlocked, parentBlocked, swBlocked, color: getComputedStyle(document.body).color, margin: getComputedStyle(document.body).margin });
    })().catch((error) => { document.body.dataset.error = String(error); });
  `,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('real SW cache restores expanded assets after reload while the game stays opaque', {
  timeout: 90000,
}, async (t) => {
  const app = new Hono();
  app.get('/game-loader/*', (c) => serveGameLoaderAsset(c));
  const assetRequests = [];
  const env = {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        assetRequests.push(path);
        const body = await readFile(new URL(`../sandbox${path}`, import.meta.url));
        return new Response(body, {
          headers: {
            'Content-Type': path.endsWith('.html')
              ? 'text/html'
              : path.endsWith('.css')
                ? 'text/css'
                : 'text/javascript',
          },
        });
      },
    },
  };
  const server = createServer(async (req, res) => {
    try {
      const response = await app.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = await engine.launch({
    headless: true,
    executablePath: process.env.LOADER_CHROMIUM_EXECUTABLE,
    args: engine === chromium ? ['--no-sandbox'] : [],
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/game-loader/prototype`;
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Choose a ZIP'));
  await page
    .locator('#archive')
    .setInputFiles({ name: 'game.zip', mimeType: 'application/zip', buffer: await fixtureZip() });
  async function verify() {
    await page.waitForFunction(() => ['ready', 'error'].includes(document.getElementById('status').dataset.state));
    assert.equal(
      await page.locator('#status').getAttribute('data-state'),
      'ready',
      await page.locator('#status').textContent(),
    );
    const game = page.frames().find((frame) => frame.url().endsWith('/game-shell.html'));
    assert.ok(game);
    await game.waitForFunction(() => document.body.dataset.result || document.body.dataset.error);
    assert.equal(await game.evaluate(() => document.body.dataset.error), undefined);
    const result = JSON.parse(await game.evaluate(() => document.body.dataset.result));
    assert.deepEqual(result, {
      value: 42,
      wasm: 42,
      xhr: 42,
      image: 1,
      canvasReadable: true,
      audio: true,
      storageBlocked: true,
      parentBlocked: true,
      swBlocked: true,
      color: 'rgb(12, 34, 56)',
      margin: '7px',
    });
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-pointer-lock');
    return JSON.parse(await page.locator('#metrics').textContent());
  }
  const cold = await verify();
  assert.equal(cold.cache, 'MISS');
  // A document reload destroys the extraction worker and in-memory file maps.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('reopen').disabled);
  const before = assetRequests.length;
  await page.locator('#reopen').click();
  const warm = await verify();
  assert.equal(warm.cache, 'HIT');
  assert.equal(warm.extractionMs, 0);
  assert.ok(!assetRequests.slice(before).some((path) => path.includes('unzip-worker')));
  assert.deepEqual(errors, []);
  // CacheStorage keys cannot be navigated to as executable HTML.
  assert.equal((await context.request.get(new URL('/game-loader/cache/files/index.html', url).href)).status(), 404);
  const unsupported = new JSZip();
  unsupported.file('index.html', '<script type="module">export {}</script>');
  await page.locator('#archive').setInputFiles({
    name: 'module.zip',
    mimeType: 'application/zip',
    buffer: await unsupported.generateAsync({ type: 'nodebuffer' }),
  });
  await page.waitForFunction(() => document.getElementById('status').dataset.state === 'error');
  assert.match(await page.locator('#status').textContent(), /require the WVFS player/);
  console.log(JSON.stringify({ browser: engine.name(), version: browser.version(), cold, warm }));
});

test('public cache miss displays WVFS before warming; cache failures preserve playback', {
  timeout: 90000,
}, async (t) => {
  let zip = await fixtureZip();
  let hidden = false;
  let revision = 'one';
  let failArchive = false;
  let archiveRequests = 0;
  let releaseArchive;
  const archiveGate = new Promise((resolve) => {
    releaseArchive = resolve;
  });
  const app = new Hono();
  app.get('/game-loader/*', (c) => serveGameLoaderAsset(c));
  app.get('/api/game-loader/:postId', (c) => servePublicLoader(c));
  app.get('/api/game-loader/:postId/archive', (c) => servePublicLoader(c));
  app.get(
    '/api/wvfs-zip/:postId',
    () =>
      new Response('<html><body>WVFS fallback is visible</body></html>', {
        headers: {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "sandbox allow-scripts; frame-ancestors 'self'",
        },
      }),
  );
  const env = {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        return new Response(await readFile(new URL(`../sandbox${path}`, import.meta.url)), {
          headers: {
            'Content-Type': path.endsWith('.html')
              ? 'text/html'
              : path.endsWith('.css')
                ? 'text/css'
                : 'text/javascript',
          },
        });
      },
    },
    CACHE: { get: async () => null },
    DB: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async first() {
            if (sql.includes('FROM posts'))
              return { payload_key: 'zip/public-game.zip', status: 'published', hidden: hidden ? 1 : 0 };
            return null;
          },
        };
      },
    },
    BUCKET: {
      head: async () => ({ etag: revision, size: zip.length }),
      async get() {
        archiveRequests++;
        if (failArchive) throw new Error('Simulated unavailable archive');
        await archiveGate;
        return { body: zip, size: zip.length };
      },
    },
  };
  const server = createServer(async (req, res) => {
    try {
      const response = await app.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = await engine.launch({
    headless: true,
    executablePath: process.env.LOADER_CHROMIUM_EXECUTABLE,
    args: engine === chromium ? ['--no-sandbox'] : [],
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `http://127.0.0.1:${server.address().port}/game-loader/player?post=public-game`;
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('status').dataset.state === 'ready');
  assert.equal(JSON.parse(await page.locator('#metrics').textContent()).mode, 'wvfs');
  await page.frameLocator('iframe').getByText('WVFS fallback is visible').waitFor();
  await page.waitForFunction(() => document.getElementById('cache-status')?.dataset.state === 'warming');
  assert.equal(await page.locator('#status').textContent(), 'Playing through WVFS.');
  // ZIP delivery is still blocked while the WVFS document is already visible.
  releaseArchive();
  await page.waitForFunction(() => document.getElementById('cache-status').dataset.state === 'saved');
  assert.equal(archiveRequests, 1);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('status').dataset.state === 'ready');
  assert.equal(JSON.parse(await page.locator('#metrics').textContent()).mode, 'cache');
  const game = page.frames().find((frame) => frame.url().endsWith('/game-shell.html'));
  assert.ok(game);
  await game.waitForFunction(() => document.body.dataset.result || document.body.dataset.error);
  assert.equal(await game.evaluate(() => document.body.dataset.error), undefined);
  assert.equal(archiveRequests, 1);
  // A changed source must miss the old cache. A failed background write/download
  // must not destroy the new WVFS iframe or change its success status.
  revision = 'two';
  failArchive = true;
  await page.reload();
  await page.waitForFunction(() => document.getElementById('cache-status')?.dataset.state === 'error');
  assert.equal(await page.locator('#status').getAttribute('data-state'), 'ready');
  await page.frameLocator('iframe').getByText('WVFS fallback is visible').waitFor();
  // A cached but unsupported game must also switch to WVFS.
  failArchive = false;
  revision = 'three';
  const modules = new JSZip();
  modules.file('index.html', '<script type="module">export {}</script>');
  zip = await modules.generateAsync({ type: 'nodebuffer' });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('cache-status')?.dataset.state === 'saved');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('status').dataset.state === 'ready');
  const unsupported = JSON.parse(await page.locator('#metrics').textContent());
  assert.equal(unsupported.mode, 'wvfs');
  assert.equal(unsupported.fallbackReason, 'loader-error');
  await page.frameLocator('iframe').getByText('WVFS fallback is visible').waitFor();
  // Even a cache hit cannot bypass the fresh publication check.
  hidden = true;
  await page.reload();
  await page.waitForFunction(() => document.getElementById('status').dataset.state === 'error');
  assert.equal(await page.locator('iframe').count(), 0);
  // SW registration failure must still allow the WVFS path.
  hidden = false;
  const withoutSw = await browser.newContext();
  const fallbackPage = await withoutSw.newPage();
  await fallbackPage.route('**/game-loader/sw.js', (route) => route.abort());
  await fallbackPage.goto(url);
  await fallbackPage.waitForFunction(() => document.getElementById('status').dataset.state === 'ready');
  assert.equal(JSON.parse(await fallbackPage.locator('#metrics').textContent()).mode, 'wvfs');
  await fallbackPage.frameLocator('iframe').getByText('WVFS fallback is visible').waitFor();
});
