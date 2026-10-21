import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeApiHref, nativeApiUrl } from '../src/lib/native-api.ts';

test('native API URL keeps browser-relative API calls unchanged', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'https:', href: 'https://flaxia.app/' } },
  });
  assert.equal(nativeApiUrl('/api/me'), '/api/me');
  delete (globalThis as { window?: unknown }).window;
});

test('custom-scheme Capacitor calls target the first-party API origin', async () => {
  delete (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'capacitor:', href: 'capacitor://localhost/', origin: 'capacitor://localhost' },
    },
  });
  const result = nativeApiUrl('/api/me?foo=bar');
  assert.equal(result, 'https://flaxia.app/api/me?foo=bar');
  assert.equal(nativeApiUrl('/assets/main.js'), '/assets/main.js');
  const rewrittenString = nativeApiUrl('/api/auth/login/start');
  assert.equal(rewrittenString, 'https://flaxia.app/api/auth/login/start');
  const inputRequest = new Request('https://localhost/api/users/me', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const rewrittenRequest = nativeApiUrl(inputRequest);
  assert.ok(rewrittenRequest instanceof Request);
  assert.equal(rewrittenRequest.url, 'https://flaxia.app/api/users/me');
  delete (globalThis as { window?: unknown }).window;
});

// Android's Capacitor HTTPS scheme uses localhost for bundled assets and
// rewrites API requests to the real first-party app origin.
test('native API URL treats https Capacitor Android as a native app', async () => {
  delete (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'https:', href: 'https://localhost/', origin: 'https://localhost' },
      Capacitor: { isNativePlatform: () => true },
    },
  });
  assert.equal(nativeApiUrl('/api/me?foo=bar'), 'https://flaxia.app/api/me?foo=bar');
  assert.equal(nativeApiHref('/api/images/avatar.png'), 'https://flaxia.app/api/images/avatar.png');
  assert.equal(nativeApiHref('/api/video/post-1'), 'https://flaxia.app/api/video/post-1');
  assert.equal(nativeApiHref('/api/games/html5/game-1'), 'https://flaxia.app/api/games/html5/game-1');
  const request = new Request('https://localhost/api/users/me', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const rewritten = nativeApiUrl(request);
  assert.ok(rewritten instanceof Request);
  assert.equal(rewritten.url.split('?')[0], 'https://flaxia.app/api/users/me');
  assert.equal(rewritten.headers.has('X-Flaxia-Native-App'), false);
  delete (globalThis as { window?: unknown }).window;
});

// A plain https browser (no Capacitor) must keep same-origin API calls.
test('native API URL leaves plain https browser API calls unchanged', async () => {
  delete (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'https:', href: 'https://flaxia.app/', origin: 'https://flaxia.app' } },
  });
  assert.equal(nativeApiUrl('/api/me'), '/api/me');
  delete (globalThis as { window?: unknown }).window;
});

for (const href of ['tauri://localhost/', 'http://tauri.localhost/', 'https://tauri.localhost/']) {
  test(`Tauri bundled origin routes API and media requests to the backend: ${href}`, () => {
    const location = new URL(href);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location } });
    try {
      assert.equal(nativeApiUrl('/api/me'), 'https://flaxia.app/api/me');
      assert.equal(nativeApiHref('/api/images/avatar.png'), 'https://flaxia.app/api/images/avatar.png');
      assert.equal(nativeApiUrl('/assets/main.js'), '/assets/main.js');
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
}
