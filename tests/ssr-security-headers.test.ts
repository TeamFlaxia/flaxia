import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { onRequest as onOgpPlayerRequest } from '../functions/api/ogp-player/[id].ts';
import { legacyRedirect, withSecurityHeaders } from '../src/hooks.server.ts';
import { PDF_VIEWER_HTML } from '../src/lib/pdf-viewer-page.ts';

test('the SvelteKit handle hook adds hardening headers to dynamic responses', async () => {
  const response = withSecurityHeaders(new Response('html', { headers: { 'Content-Type': 'text/html' } }));
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(await response.text(), 'html');
});

test('the handle hook preserves an existing security header', async () => {
  const response = withSecurityHeaders(new Response('ok', { headers: { 'X-Frame-Options': 'SAMEORIGIN' } }));
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('parameterised ActivityPub redirects moved from _redirects into the hook', () => {
  assert.deepEqual(legacyRedirect('/actors/alice'), { location: '/api/actors/alice', status: 301 });
  assert.deepEqual(legacyRedirect('/actors/alice/outbox'), { location: '/api/actors/alice/outbox', status: 301 });
  assert.deepEqual(legacyRedirect('/actors/alice/followers'), {
    location: '/api/actors/alice/followers',
    status: 301,
  });
  assert.deepEqual(legacyRedirect('/users/alice/inbox'), { location: '/api/actors/alice/inbox', status: 308 });
  assert.deepEqual(legacyRedirect('/notes/abc'), { location: '/api/notes/abc', status: 301 });
  // Profile pages stay SvelteKit routes; only the ActivityPub inbox is redirected.
  assert.equal(legacyRedirect('/users/alice'), null);
  assert.equal(legacyRedirect('/home'), null);
});

test('OGP game player responses allow same-origin arcade embedding', async () => {
  const games = [
    { row: { payload_key: 'payload.zip', swf_key: null }, expectedTag: '<iframe src=' },
    { row: { payload_key: null, swf_key: 'game.swf' }, expectedTag: '<embed src=' },
  ];

  for (const { row, expectedTag } of games) {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => row }),
        }),
      },
      BASE_URL: 'https://flaxia.app',
      SANDBOX_ORIGIN: 'https://sandbox.flaxia.app',
    } as unknown as Parameters<typeof onOgpPlayerRequest>[0]['env'];
    const request = new Request('https://flaxia.app/api/ogp-player/game-1');
    const response = await onOgpPlayerRequest({ request, env, params: { id: 'game-1' } });

    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
    assert.ok((await response.text()).includes(expectedTag));
  }
});

test('main CSP applies to legacy paths; game previews use sandbox.flaxia.app', async () => {
  const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  assert.doesNotMatch(headers, /^\/sandbox(?:\/\*)?$/m, 'main-origin sandbox exceptions must stay retired');
  assert.match(headers, /X-Frame-Options: DENY/);

  const legacyPage = await readFile(new URL('../public/sandbox/index.html', import.meta.url), 'utf8');
  const sandboxHeaders = await readFile(new URL('../public/sandbox/_headers', import.meta.url), 'utf8');
  assert.doesNotMatch(legacyPage, /<script\b/i, 'legacy main-origin sandbox must not execute user content');
  assert.match(sandboxHeaders, /frame-ancestors 'none'/);
  assert.match(sandboxHeaders, /X-Frame-Options: DENY/);

  const sandboxPreview = await readFile(new URL('../sandbox/zip-preview.html', import.meta.url), 'utf8');
  const sandboxScript = await readFile(new URL('../sandbox/zip-preview.js', import.meta.url), 'utf8');
  const sandboxWorker = await readFile(new URL('../src/sandbox-worker.ts', import.meta.url), 'utf8');
  assert.match(sandboxWorker, /app\.get\('\/zip-preview'/);
  assert.match(sandboxWorker, /ZIP_PREVIEW_CSP/);
  assert.match(sandboxPreview, /src="\/zip-preview\.js"/);
  assert.match(sandboxScript, /event\.source !== window\.parent/);
  assert.match(sandboxScript, /setAttribute\('sandbox', 'allow-scripts/);
  assert.doesNotMatch(sandboxScript, /allow-same-origin/);
});

test('legacy Arcade frames use the sandbox WVFS route and typed opaque bridge', async () => {
  const sandboxFrame = await readFile(new URL('../src/components/SandboxFrame.ts', import.meta.url), 'utf8');
  const frameBridge = await readFile(new URL('../src/lib/multiplayer-frame.ts', import.meta.url), 'utf8');
  const multiplayer = await readFile(new URL('../src/lib/multiplayer-manager.ts', import.meta.url), 'utf8');
  assert.match(sandboxFrame, /createWvfsGameUrl/);
  const gameUrl = await readFile(new URL('../shared/wvfs-game-url.ts', import.meta.url), 'utf8');
  assert.match(gameUrl, /api\/wvfs-zip\//);
  assert.match(sandboxFrame, /iframe\.sandbox = 'allow-scripts allow-pointer-lock allow-forms allow-popups'/);
  assert.match(sandboxFrame, /iframe\.allow = 'fullscreen; web-share'/);
  assert.doesNotMatch(sandboxFrame, /\/run\//, 'retired /run route must not be used');
  assert.match(frameBridge, /event\.source !== iframe\.contentWindow \|\| event\.origin !== 'null'/);
  assert.match(frameBridge, /isParentMessage\(data\)/);
  assert.match(multiplayer, /isParentMessage\(message\)/);
  assert.match(multiplayer, /postMessage\(message, '\*'\)/);
  assert.doesNotMatch(sandboxFrame + frameBridge + multiplayer, /allow-same-origin/);
});

test('sandbox policies separate permissive games from the pinned PDF viewer', async () => {
  const worker = await readFile(new URL('../src/sandbox-worker.ts', import.meta.url), 'utf8');
  const viewer = await readFile(new URL('../src/components/DocumentViewer.ts', import.meta.url), 'utf8');
  const pdfScript = PDF_VIEWER_HTML.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  const pdfPolicy = worker.match(/const PDF_VIEWER_CSP = \[([\s\S]*?)\]\.join/)?.[1] ?? '';
  const pdfScriptSrc = pdfPolicy.match(/"script-src ([^"]+)"/)?.[1] ?? '';
  assert.ok(pdfScript);
  assert.ok(pdfScriptSrc.includes("'sha256-" + createHash('sha256').update(pdfScript).digest('base64') + "'"));
  assert.doesNotMatch(pdfScriptSrc, /'unsafe-inline'|'unsafe-eval'/);
  assert.match(pdfPolicy, /default-src 'none'/);
  assert.match(viewer, /event\.origin !== sandboxOrigin/);
  assert.match(viewer, /postMessage\(message, sandboxOrigin, \[bytes\]\)/);
  assert.match(viewer, /isSandboxMessage\(message\)/);
});

test('SvelteKit emits the main policy; no static header or inline handlers shadow it', async () => {
  const config = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  assert.doesNotMatch(headers, /^\s*Content-Security-Policy:/m);
  assert.match(config, /'script-src-attr': \['none'\]/);
  assert.doesNotMatch(config, /'unsafe-eval'/);
  assert.doesNotMatch(config, /script-src[^\]]*'unsafe-inline'/);
  assert.match(config, /'wasm-unsafe-eval'/);
  assert.match(config, /https:\/\/cdn\.jsdelivr\.net/);

  const appHtml = await readFile(new URL('../src/app.html', import.meta.url), 'utf8');
  assert.doesNotMatch(appHtml, /\son[a-z]+\s*=/i, 'static app HTML must not contain inline event handlers');

  const sandboxPage = await readFile(new URL('../sandbox/zip-preview.html', import.meta.url), 'utf8');
  const sandboxScript = await readFile(new URL('../sandbox/zip-preview.js', import.meta.url), 'utf8');
  const jszipBundle = await readFile(new URL('../node_modules/jszip/dist/jszip.min.js', import.meta.url));
  const jszipIntegrity = 'sha384-' + createHash('sha384').update(jszipBundle).digest('base64');
  const sandboxPreview = await readFile(new URL('../src/lib/sandbox-zip-preview.ts', import.meta.url), 'utf8');
  const workerConfig = await readFile(new URL('../wrangler.sandbox.toml', import.meta.url), 'utf8');
  const sandboxWorker = await readFile(new URL('../src/sandbox-worker.ts', import.meta.url), 'utf8');
  const protocol = await readFile(new URL('../sandbox/zip-preview-protocol.js', import.meta.url), 'utf8');
  const previewPolicy = sandboxWorker.match(/const ZIP_PREVIEW_CSP = \[([\s\S]*?)\]\.join/)?.[1] ?? '';
  assert.match(sandboxPage, /src="\/zip-preview\.js"/);
  assert.match(sandboxScript, /isSandboxZipPreviewMessage/);
  assert.match(sandboxScript, /zip-preview-protocol\.js/);
  assert.match(sandboxScript, /setAttribute\('sandbox', 'allow-scripts/);
  assert.doesNotMatch(sandboxScript, /allow-same-origin/, 'game documents must keep an opaque sandbox origin');
  assert.ok(sandboxScript.includes("script.integrity = '" + jszipIntegrity + "'"));
  assert.doesNotMatch(previewPolicy, /sandbox allow-/, 'trusted wrapper must retain its cross-origin sandbox origin');
  assert.match(previewPolicy, /frame-src blob: data: https:/);
  assert.match(protocol, /MAX_SANDBOX_ZIP_PREVIEW_BYTES/);
  assert.match(sandboxPreview, /VITE_SANDBOX_ORIGIN/);
  assert.match(sandboxPreview, /event\.origin !== sandboxOrigin/);
  assert.match(sandboxPreview, /iframe\.src = sandboxOrigin \+ '\/zip-preview'/);
  assert.match(sandboxPreview, /postMessage\(request, sandboxOrigin, \[zipData\]\)/);
  assert.doesNotMatch(sandboxPreview, /postMessage\([^;]*, '\*'/);
  assert.doesNotMatch(sandboxPreview, /allow-same-origin/);
  assert.match(workerConfig, /directory = "\.\/sandbox"/);
  assert.match(sandboxWorker, /app\.get\('\/zip-preview\.js'/);
  assert.match(sandboxWorker, /app\.get\('\/zip-preview-protocol\.js'/);
});
