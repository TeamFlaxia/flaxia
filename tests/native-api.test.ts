import assert from 'node:assert/strict';
import test from 'node:test';
import { isNativeApiUrl, nativeApiHref, nativeApiUrl } from '../src/lib/native-api.ts';

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
  const inputRequest = new Request('capacitor://localhost/api/users/me', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const rewrittenRequest = nativeApiUrl(inputRequest);
  assert.ok(rewrittenRequest instanceof Request);
  assert.equal(rewrittenRequest.url, 'https://flaxia.app/api/users/me');
  delete (globalThis as { window?: unknown }).window;
});

test('Tauri keeps Flaxia service API origins for the native transport', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'tauri:', href: 'tauri://localhost/', origin: 'tauri://localhost' },
      __TAURI_INTERNALS__: {},
    },
  });
  assert.equal(
    nativeApiHref('https://auth.flaxia.app/api/auth/login/start'),
    'https://auth.flaxia.app/api/auth/login/start',
  );
  assert.equal(
    nativeApiUrl('https://auth.flaxia.app/api/auth/login/start'),
    'https://auth.flaxia.app/api/auth/login/start',
  );
  const request = new Request('https://auth.flaxia.app/api/auth/login/start', {
    method: 'POST',
    body: '{}',
  });
  const rewritten = nativeApiUrl(request);
  assert.ok(rewritten instanceof Request);
  assert.equal(rewritten.url, 'https://auth.flaxia.app/api/auth/login/start');
  assert.equal(nativeApiHref('/api/me'), 'https://flaxia.app/api/me');
  assert.equal(nativeApiHref('https://notflaxia.app/api/me'), 'https://notflaxia.app/api/me');
  assert.equal(nativeApiHref('https://flaxia.app.evil.test/api/me'), 'https://flaxia.app.evil.test/api/me');
  delete (globalThis as { window?: unknown }).window;
});

test('only the first-party origin and allowlisted service APIs use the native transport', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'tauri:', href: 'tauri://localhost/', origin: 'tauri://localhost' },
      __TAURI_INTERNALS__: {},
    },
  });
  try {
    assert.equal(isNativeApiUrl(new URL('https://flaxia.app/api/me')), true);
    assert.equal(isNativeApiUrl(new URL('https://auth.flaxia.app/api/auth/login/start')), true);
    assert.equal(isNativeApiUrl(new URL('https://sandbox.flaxia.app/api/wvfs-zip/game-1')), false);
    assert.equal(isNativeApiUrl(new URL('https://evil.flaxia.app/api/me')), false);
    assert.equal(isNativeApiUrl(new URL('https://auth.flaxia.app/other')), false);
    assert.equal(isNativeApiUrl(new URL('http://auth.flaxia.app/api/me')), false);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
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
