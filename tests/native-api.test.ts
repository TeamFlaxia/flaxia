import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeApiUrl } from '../src/lib/native-api.ts';

test('native API URL keeps browser-relative API calls unchanged', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'https:', href: 'https://flaxia.app/' } },
  });
  assert.equal(nativeApiUrl('/api/me'), '/api/me');
  delete (globalThis as { window?: unknown }).window;
});

test('native API URL redirects Capacitor API calls to the production origin', async () => {
  delete (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'capacitor:', href: 'capacitor://localhost/', origin: 'capacitor://localhost' },
    },
  });
  const result = nativeApiUrl('/api/me?foo=bar');
  assert.equal(typeof result, 'string');
  assert.equal((result as string).split('?')[0], 'https://flaxia.app/api/me');
  assert.match(result as string, /foo=bar/);
  assert.equal(nativeApiUrl('/assets/main.js'), '/assets/main.js');
  const rewrittenString = nativeApiUrl('/api/auth/login/start');
  assert.equal(typeof rewrittenString, 'string');
  assert.equal(rewrittenString, 'https://flaxia.app/api/auth/login/start');
  const inputRequest = new Request('https://localhost/api/users/me', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const rewrittenRequestObject = nativeApiUrl(inputRequest);
  assert.ok(rewrittenRequestObject instanceof Request);
  assert.equal(rewrittenRequestObject.headers.get('X-Flaxia-Native-App'), '1');
  const request = new Request('https://localhost/api/users/me', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const rewrittenRequest = nativeApiUrl(request);
  assert.ok(rewrittenRequest instanceof Request);
  assert.equal(rewrittenRequest.url.split('?')[0], 'https://flaxia.app/api/users/me');
  assert.equal(rewrittenRequest.method, 'DELETE');
  assert.equal(rewrittenRequest.headers.get('X-Flaxia-Native-App'), '1');
  delete (globalThis as { window?: unknown }).window;
});

// The Android build uses androidScheme: 'https', so the WebView protocol is
// https: rather than capacitor:. Detecting the native app by protocol alone
// misses this build and routes API calls to https://localhost, which has no
// server. The Capacitor native-platform flag is the reliable signal.
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
  const request = new Request('https://localhost/api/users/me', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const rewritten = nativeApiUrl(request);
  assert.ok(rewritten instanceof Request);
  assert.equal(rewritten.url.split('?')[0], 'https://flaxia.app/api/users/me');
  assert.equal(rewritten.headers.get('X-Flaxia-Native-App'), '1');
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
