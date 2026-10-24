import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { nativeApiHref, nativeApiUrl } from '../src/lib/native-api.ts';
import { createNativeFetch } from '../src/lib/native-fetch.ts';

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});
function platform(kind: 'android' | 'ios' | 'tauri') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href:
          kind === 'ios' ? 'capacitor://localhost/' : kind === 'tauri' ? 'tauri://localhost/' : 'https://localhost/',
      },
      Capacitor: { isNativePlatform: () => kind !== 'tauri' },
      __TAURI_INTERNALS__: kind === 'tauri',
    },
  });
}
for (const kind of ['android', 'ios', 'tauri'] as const) {
  test(kind + ' rewrites app-relative APIs while leaving external URLs unchanged', () => {
    platform(kind);
    assert.equal(nativeApiHref('/api/me'), 'https://flaxia.app/api/me');
    assert.equal(nativeApiUrl('https://other.example/api/me'), 'https://other.example/api/me');
    assert.equal(nativeApiHref('https://other.example/api/me'), 'https://other.example/api/me');
    assert.equal(nativeApiUrl('/locales/ja.json'), '/locales/ja.json');
  });
}
test('Capacitor preserves multipart bodies and RequestInit overrides', async () => {
  platform('android');
  let actual: Request | undefined;
  const native = createNativeFetch(async (input, init) => {
    assert.ok(init?.body instanceof FormData, 'Capacitor needs the raw FormData, not a body stream');
    actual = new Request(input, init);
    return Response.json({ ok: true });
  });
  const form = new FormData();
  form.append('file', new Blob(['contents'], { type: 'image/png' }), 'preview.png');
  await native(new Request('https://localhost/api/media', { method: 'POST', body: 'old' }), {
    method: 'PUT',
    body: form,
    headers: { 'X-Test': 'override' },
  });
  assert.ok(actual);
  assert.equal(actual.url, 'https://flaxia.app/api/media');
  assert.equal(actual.method, 'PUT');
  assert.equal(actual.credentials, 'include');
  assert.equal(actual.headers.get('X-Test'), 'override');
  const file = (await actual.formData()).get('file') as File;
  assert.equal(file.name, 'preview.png');
  assert.equal(await file.text(), 'contents');
});

test('Capacitor bridges JSON and raw binary without decoding binary as text', async () => {
  platform('android');
  const sent: RequestInit[] = [];
  const native = createNativeFetch(async (_input, init) => {
    sent.push(init!);
    return Response.json({ ok: true });
  });
  await native('/api/auth/login/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proof: 'value' }),
  });
  assert.equal(sent[0].body, JSON.stringify({ proof: 'value' }));
  const bytes = new Uint8Array([0, 255, 128, 10]);
  await native('/api/media/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  assert.ok(sent[1].body instanceof File);
  assert.deepEqual(new Uint8Array(await sent[1].body.arrayBuffer()), bytes);
});
test('Tauri uses its scoped native transport without exposing session cookies to JS', async () => {
  platform('tauri');
  let actual: Request | undefined;
  let redirects: number | undefined;
  const transport: typeof import('@tauri-apps/plugin-http').fetch = async (input, init) => {
    actual = input as Request;
    redirects = init?.maxRedirections;
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'session=private; HttpOnly; Secure' } });
  };
  const native = createNativeFetch(
    async () => {
      throw new Error('wrong transport');
    },
    async () => transport,
  );
  const body = JSON.stringify({ M1: 'proof' });
  const response = await native('/api/auth/login/finish', { method: 'POST', body });
  assert.ok(actual);
  assert.equal(actual.url, 'https://flaxia.app/api/auth/login/finish');
  assert.equal(await actual.text(), body);
  assert.equal(redirects, 0);
  assert.equal(response.headers.has('Set-Cookie'), false);
  assert.equal(response.clone().headers.has('Set-Cookie'), false);
  assert.deepEqual(await response.json(), { ok: true });
});
test('static assets and third-party APIs keep the browser transport', async () => {
  platform('tauri');
  const received: Array<RequestInfo | URL> = [];
  const native = createNativeFetch(
    async (input) => {
      received.push(input);
      return new Response('static');
    },
    async () => {
      throw new Error('unexpected native request');
    },
  );
  await native('/locales/ja.json');
  await native('https://other.example/api/upload', { method: 'POST', body: 'data' });
  assert.deepEqual(received, ['/locales/ja.json', 'https://other.example/api/upload']);
});

test('Capacitor reads use native HTTP directly and decode JSON/binary without exposing cookies', async () => {
  platform('android');
  let binary = false;
  const native = createNativeFetch(
    async () => assert.fail('reads must not use the WebView proxy'),
    undefined,
    async () => ({
      platform: 'android',
      request: async (options) => {
        assert.equal(options.disableRedirects, true);
        assert.equal(options.responseType, 'arraybuffer');
        assert.equal(options.url.startsWith('https://flaxia.app/api/'), true);
        return {
          status: 200,
          url: options.url,
          headers: {
            'Content-Type': binary ? 'application/octet-stream' : 'application/json',
            'Set-Cookie': 'secret=private',
          },
          data: binary ? 'AP+ACg==' : { posts: ['native'] },
        };
      },
    }),
  );
  const response = await native('/api/posts');
  assert.deepEqual(await response.json(), { posts: ['native'] });
  assert.equal(response.url, 'https://flaxia.app/api/posts');
  assert.equal(response.headers.get('Set-Cookie'), null);
  binary = true;
  const archive = await native('/api/game-loader/game1/archive');
  assert.deepEqual(new Uint8Array(await archive.arrayBuffer()), new Uint8Array([0, 255, 128, 10]));
});

test('Capacitor native reads preserve HTTP errors and ignore responses after abort', async () => {
  platform('android');
  let release!: (value: import('@capacitor/core').HttpResponse) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let pending = false;
  const native = createNativeFetch(
    async () => assert.fail('unexpected proxy'),
    undefined,
    async () => ({
      platform: 'android',
      request: async (options) => {
        if (pending) {
          started();
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return { status: 404, headers: { 'Content-Type': 'text/plain' }, data: 'Not found', url: options.url };
      },
    }),
  );
  const missing = await native('/api/game-loader/game1');
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Not found');
  pending = true;
  const controller = new AbortController();
  const reading = native('/api/posts', { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  release({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    data: { posts: [] },
    url: 'https://flaxia.app/api/posts',
  });
});
