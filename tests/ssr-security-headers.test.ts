import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { onRequest } from '../functions/_middleware.ts';
import { onRequest as onOgpPlayerRequest } from '../functions/api/ogp-player/[id].ts';
import { applySecurityHeaders, SECURITY_HEADERS } from '../functions/lib/ssr-security-headers.ts';

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

test('middleware policy matches static asset security headers', async () => {
  const staticHeaders = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = staticHeaders.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1];
  assert.ok(csp, 'public/_headers must define the static asset CSP');
  const actualResponse = applySecurityHeaders(new Response('ok'));
  assert.equal(actualResponse.headers.get('content-security-policy'), csp);
  assert.equal(SECURITY_HEADERS.find(([name]) => name === 'Content-Security-Policy')?.[1], csp);
});
