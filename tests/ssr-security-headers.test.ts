import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { onRequest } from '../functions/_middleware.ts';
import { onRequest as onOgpPlayerRequest } from '../functions/api/ogp-player/[id].ts';
import { applySecurityHeaders, SECURITY_HEADERS } from '../functions/lib/ssr-security-headers.ts';
import { ADSENSE_INLINE_BOOTSTRAP } from '../src/lib/adsense-bootstrap.ts';
import { buildFlashPlayerDocument } from '../src/lib/flash-player-document.ts';
import { PDF_VIEWER_HTML } from '../src/lib/pdf-viewer-page.ts';
import { renderHtmlShell } from '../src/lib/render-html.ts';

test('Pages middleware adds security headers to dynamic responses', async () => {
  const response = await onRequest({
    request: new Request('https://flaxia.app/thread/example'),
    env: {},
    next: async () => new Response('html', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
  });

  assert.equal(response.headers.get('content-security-policy')?.includes("frame-ancestors 'self'"), true);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(await response.text(), 'html');
});

test('Pages middleware preserves an existing security header', async () => {
  const response = await onRequest({
    request: new Request('https://flaxia.app/'),
    env: {},
    next: async () =>
      new Response('ok', {
        headers: { 'Content-Security-Policy': "default-src 'none'", 'X-Frame-Options': 'SAMEORIGIN' },
      }),
  });

  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('Pages middleware adds security headers to unsupported-domain 404s', async () => {
  const response = await onRequest({
    request: new Request('https://preview.pages.dev/'),
    env: {},
    next: async () => {
      throw new Error('next must not run for pages.dev hosts');
    },
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-security-policy')?.includes("frame-ancestors 'self'"), true);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
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
    const playerResponse = await onOgpPlayerRequest({ request, env, params: { id: 'game-1' } });
    const response = await onRequest({ request, env: {}, next: async () => playerResponse });

    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('content-security-policy')?.includes("frame-ancestors 'self'"), true);
    assert.ok((await response.text()).includes(expectedTag));
  }
});

test('main CSP applies to legacy paths; game previews use sandbox.flaxia.app', async () => {
  const staticHeaders = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = staticHeaders.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1];
  assert.ok(csp, 'public/_headers must define the main-site CSP');
  const actualResponse = applySecurityHeaders(new Response('ok'), '/home');
  assert.equal(actualResponse.headers.get('content-security-policy'), csp);
  assert.equal(SECURITY_HEADERS.find(([name]) => name === 'Content-Security-Policy')?.[1], csp);

  const legacyResponse = applySecurityHeaders(new Response('notice'), '/sandbox/index.html');
  assert.equal(legacyResponse.headers.get('content-security-policy'), csp);
  assert.equal(legacyResponse.headers.get('x-frame-options'), 'DENY');
  assert.doesNotMatch(staticHeaders, /^\/sandbox(?:\/\*)?$/m, 'main-origin sandbox exceptions must stay retired');

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
  assert.match(sandboxWorker, /var storageKey='flaxia:game:'\\+namespace/);
  assert.match(sandboxWorker, /var legacyKey=namespace/);
  assert.match(sandboxWorker, /localStorage\\.getItem\\(storageKey\\)/);
  assert.match(sandboxWorker, /localStorage\\.getItem\\(legacyKey\\)/);
  assert.match(sandboxWorker, /localStorage\\.setItem\\(storageKey,JSON\\.stringify\\(legacy\\)\\)/);
  assert.match(sandboxPreview, /src="\/zip-preview\.js"/);
  assert.match(sandboxScript, /event\.source !== window\.parent/);
  assert.match(sandboxScript, /setAttribute\('sandbox', 'allow-scripts/);
  assert.doesNotMatch(sandboxScript, /allow-same-origin/);
});

test('legacy Arcade frames use the sandbox WVFS route and typed opaque bridge', async () => {
  const sandboxFrame = await readFile(new URL('../src/components/SandboxFrame.ts', import.meta.url), 'utf8');
  const multiplayer = await readFile(new URL('../src/lib/multiplayer-manager.ts', import.meta.url), 'utf8');
  assert.match(sandboxFrame, /api\/wvfs-zip\//);
  assert.match(sandboxFrame, /iframe\.sandbox = 'allow-scripts allow-pointer-lock allow-forms allow-popups'/);
  assert.match(sandboxFrame, /iframe\.allow = 'fullscreen; web-share'/);
  assert.doesNotMatch(sandboxFrame, /\/run\//, 'retired /run route must not be used');
  assert.match(sandboxFrame, /event\.source !== iframe\.contentWindow \|\| event\.origin !== 'null'/);
  assert.match(sandboxFrame, /isParentMessage\(data\)/);
  assert.match(multiplayer, /isParentMessage\(message\)/);
  assert.match(multiplayer, /postMessage\(message, '\*'\)/);
  assert.doesNotMatch(sandboxFrame + multiplayer, /allow-same-origin/);
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

test('main policy hashes trusted inline scripts and blocks other inline JS', async () => {
  const csp = SECURITY_HEADERS.find(([name]) => name === 'Content-Security-Policy')?.[1];
  assert.ok(csp);
  const scriptSrc = /(?:^|;)\s*script-src ([^;]+)/.exec(csp)?.[1] ?? '';
  const hashSource = (body: string) => "'sha256-" + createHash('sha256').update(body).digest('base64') + "'";
  const inlineBodies = (html: string) =>
    [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(([, attrs]) => {
        if (/\bsrc\s*=/.test(attrs)) return false;
        return !/\btype\s*=\s*['"]application\/ld\+json['"]/i.test(attrs);
      })
      .map(([, , body]) => body);

  const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const exportPopup = await readFile(new URL('../export-popup.html', import.meta.url), 'utf8');
  const ssr = renderHtmlShell('<p>fixture</p>', {
    title: 'CSP test',
    description: 'CSP test page',
    canonicalUrl: 'https://flaxia.app/csp-test',
  });
  const flashPlayer = buildFlashPlayerDocument('Flash', 'Unable to load Flash');
  for (const [label, html] of [
    ['index.html', index],
    ['export-popup.html', exportPopup],
    ['SSR shell', ssr],
    ['Flash player blob', flashPlayer],
  ]) {
    for (const body of inlineBodies(html)) {
      assert.ok(scriptSrc.includes(hashSource(body)), label + ' has an inline script without a CSP hash');
    }
  }
  assert.ok(scriptSrc.includes(hashSource(ADSENSE_INLINE_BOOTSTRAP)), 'AdSense iframe bootstrap must stay allowed');
  assert.ok(
    scriptSrc.includes("'sha256-9jpcqwJpr7kicF5b0vRUbAJtyA6CqjotdcnTjIv8i4U='"),
    'legacy ZIP wrapper bootstrap must stay allowed',
  );
  assert.doesNotMatch(index, /\son[a-z]+\s*=/i, 'static app HTML must not contain inline event handlers');
  assert.doesNotMatch(ssr, /\son[a-z]+\s*=/i, 'SSR shell must not contain inline event handlers');

  const legacyPage = await readFile(new URL('../public/sandbox/index.html', import.meta.url), 'utf8');
  const sandboxPage = await readFile(new URL('../sandbox/zip-preview.html', import.meta.url), 'utf8');
  const sandboxScript = await readFile(new URL('../sandbox/zip-preview.js', import.meta.url), 'utf8');
  const jszipBundle = await readFile(new URL('../node_modules/jszip/dist/jszip.min.js', import.meta.url));
  const jszipIntegrity = 'sha384-' + createHash('sha384').update(jszipBundle).digest('base64');
  const sandboxPreview = await readFile(new URL('../src/lib/sandbox-zip-preview.ts', import.meta.url), 'utf8');
  const workerConfig = await readFile(new URL('../wrangler.sandbox.toml', import.meta.url), 'utf8');
  const sandboxWorker = await readFile(new URL('../src/sandbox-worker.ts', import.meta.url), 'utf8');
  const protocol = await readFile(new URL('../sandbox/zip-preview-protocol.js', import.meta.url), 'utf8');
  const previewPolicy = sandboxWorker.match(/const ZIP_PREVIEW_CSP = \[([\s\S]*?)\]\.join/)?.[1] ?? '';
  assert.doesNotMatch(legacyPage, /<script\b|EXECUTE_ZIP/i, 'legacy main-origin path must not execute game content');
  assert.match(sandboxPage, /src="\/zip-preview\.js"/);
  assert.match(sandboxScript, /event\.source !== window\.parent/);
  assert.match(sandboxScript, /isSandboxZipPreviewMessage/);
  assert.match(sandboxScript, /zip-preview-protocol\.js/);
  assert.match(sandboxScript, /setAttribute\('sandbox', 'allow-scripts/);
  assert.doesNotMatch(sandboxScript, /allow-same-origin/, 'game documents must keep an opaque sandbox origin');
  assert.doesNotMatch(sandboxScript, /isExecuteZipRequest/, 'player must use the shared runtime validator');
  assert.ok(sandboxScript.includes("script.integrity = '" + jszipIntegrity + "'"));
  assert.match(sandboxScript, /htmlContent\.replace\(\/<\(\[\^>\]\+\)\\s\+src/);
  assert.doesNotMatch(previewPolicy, /sandbox allow-/, 'trusted wrapper must retain its cross-origin sandbox origin');
  assert.match(previewPolicy, /frame-src blob: data: https:/);
  assert.match(protocol, /MAX_SANDBOX_ZIP_PREVIEW_BYTES/);
  assert.match(sandboxPreview, /VITE_SANDBOX_ORIGIN/);
  assert.match(sandboxPreview, /event\.origin !== sandboxOrigin/);
  assert.match(sandboxPreview, /iframe\.src = sandboxOrigin \+ '\/zip-preview'/);
  assert.match(sandboxPreview, /postMessage\(request, sandboxOrigin, \[zipData\]\)/);
  assert.doesNotMatch(sandboxPreview, /postMessage\([^;]*, '\*'/);
  assert.doesNotMatch(sandboxPreview, /setAttribute\('sandbox'/, 'only untrusted game documents are sandboxed');
  assert.doesNotMatch(sandboxPreview, /allow-same-origin/);
  assert.match(workerConfig, /directory = \"\.\/sandbox\"/);
  assert.match(sandboxWorker, /app\.get\('\/zip-preview\.js'/);
  assert.match(sandboxWorker, /app\.get\('\/zip-preview-protocol\.js'/);
});
