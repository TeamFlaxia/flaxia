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
