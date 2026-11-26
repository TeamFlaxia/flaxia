// SSR injects the request's locale and (for document navigations only) a
// privacy-filtered session into the HTML so the browser can hydrate with zero
// boot requests. The payload must be inert JSON: the CSP header is finalised
// before transformPageChunk, so a new executable script could never run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applyHtmlLang, handle, injectBootData, safeJson, withSecurityHeaders } from '../src/hooks.server.ts';

const MARKER = '<!--FLAXIA_BOOT_DATA-->';
const HTML = `<!DOCTYPE html><html lang="en"><head>${MARKER}</head><body></body></html>`;

const LOCALE = {
  locale: 'ja',
  strings: { shared: 'local override', only_ja: '日本語', empty: '' },
  fallback: { shared: 'fallback', only_en: 'English', empty: 'not empty' },
};

interface BootPayload {
  locale: { locale: string; strings: Record<string, string> };
  session?: Record<string, unknown> | null;
}

function injected(session?: Record<string, unknown> | null): string {
  return injectBootData(HTML, LOCALE, session);
}

function payloadOf(html: string): BootPayload {
  const match = html.match(/<script type="application\/json" id="__flaxia_boot__">([\s\S]*?)<\/script>/);
  assert.ok(match, 'a JSON boot script must be injected at the marker');
  return JSON.parse(match[1]) as BootPayload;
}

function hookSource(): Promise<string> {
  return readFile(new URL('../src/hooks.server.ts', import.meta.url), 'utf8');
}

function appHtmlSource(): Promise<string> {
  return readFile(new URL('../src/app.html', import.meta.url), 'utf8');
}

test('safeJson escapes script-breaking characters and preserves the value', () => {
  const original = { text: '</script><script>alert(1)</script>\u2028\u2029<>' };
  const json = safeJson(original);

  assert.doesNotMatch(json, /</);
  assert.doesNotMatch(json, />/);
  assert.doesNotMatch(json, /\u2028|\u2029/);
  assert.deepEqual(JSON.parse(json), original);
});

test('injectBootData replaces the marker once with an inert JSON script', () => {
  const once = injected();
  assert.equal(once.split('<script type="application/json" id="__flaxia_boot__">').length - 1, 1);
  assert.ok(!once.includes(MARKER), 'the marker must be gone after injection');

  const twice = injectBootData(`${MARKER}<p>x</p>${MARKER}`, LOCALE, undefined);
  assert.equal(twice.split('<script type="application/json" id="__flaxia_boot__">').length - 1, 1);
  assert.ok(twice.includes(MARKER), 'only the first marker is replaced');
});

test('injected locale strings merge the fallback with request-scoped overrides', () => {
  assert.deepEqual(payloadOf(injected()).locale, {
    locale: 'ja',
    strings: { only_en: 'English', shared: 'local override', only_ja: '日本語', empty: '' },
  });
});

test('injected session is included only when it is known (null is explicit)', () => {
  const guest = payloadOf(injected(null));
  assert.ok('session' in guest, 'a 401 must be embedded as an explicit null');
  assert.equal(guest.session, null);

  const user = { id: 'u1', username: 'alice', display_name: 'Alice' };
  assert.deepEqual(payloadOf(injected(user)).session, user);

  assert.ok(!('session' in payloadOf(injected(undefined))), 'unknown session must omit the key');
});

test('hostile locale text cannot escape the JSON block', () => {
  const html = injectBootData(
    HTML,
    { ...LOCALE, strings: { attack: '</script><img src=x onerror=alert(1)>' } },
    undefined,
  );
  assert.ok(!html.includes('</script><img'), 'payload text must be escaped');
  assert.equal(payloadOf(html).locale.strings.attack, '</script><img src=x onerror=alert(1)>');
});

type FetchCall = { path: string; init?: RequestInit };

function bootEvent(request: Request, calls: FetchCall[], me?: () => Promise<Response>) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    calls.push({ path, init });
    if (path === '/api/me') return me ? me() : Response.json({ user: {} });
    const strings = path === '/locales/ja.json' ? { home_title: 'ホーム' } : { home_title: 'Home' };
    return Response.json(strings);
  };
  const event = {
    url: new URL(request.url),
    request,
    fetch: fetchImpl,
    cookies: {
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
      serialize: () => 'flaxia_locale=ja',
    },
  };
  return event as unknown as Parameters<typeof handle>[0]['event'];
}

async function renderDocument(
  request: Request,
  calls: FetchCall[],
  me?: () => Promise<Response>,
): Promise<{ response: Response; html: string }> {
  const response = await handle({
    event: bootEvent(request, calls, me),
    resolve: (_event, opts) => {
      const transformed = opts?.transformPageChunk?.({ html: HTML, done: true }) ?? HTML;
      return Promise.resolve(
        new Response(String(transformed), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      );
    },
  } as unknown as Parameters<typeof handle>[0]);
  return { response, html: await response.text() };
}

function documentRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://flaxia.app/home', {
    headers: { 'sec-fetch-dest': 'document', accept: 'text/html,application/xhtml+xml', ...headers },
  });
}

test('document navigation embeds a bounded session read with only public fields', async () => {
  const calls: FetchCall[] = [];
  const { html } = await renderDocument(documentRequest(), calls, () =>
    Promise.resolve(
      Response.json({
        user: {
          id: 'u1',
          username: 'alice',
          display_name: 'Alice',
          avatar_key: 'avatar/1',
          badge_type: 'flaxia_plus',
          name_color: '#ff0000',
          email: 'secret@example.com',
          role: 'admin',
          token: 'session-token',
          ng_words: ['secret'],
          srp_salt: 'salt',
        },
      }),
    ),
  );

  const meCall = calls.find((call) => call.path === '/api/me');
  assert.ok(meCall, 'document navigations must read /api/me once via event.fetch');
  assert.ok(meCall?.init?.signal instanceof AbortSignal, 'the read must be abortable');

  const data = payloadOf(html);
  assert.deepEqual(data.session, {
    id: 'u1',
    username: 'alice',
    display_name: 'Alice',
    avatar_key: 'avatar/1',
    badge_type: 'flaxia_plus',
    name_color: '#ff0000',
  });
  for (const forbidden of ['secret@example.com', '"role"', '"token"', '"ng_words"', 'srp_salt']) {
    assert.ok(!html.includes(forbidden), `${forbidden} must never reach the HTML`);
  }
  assert.match(html, /<html lang="en">/, 'applyHtmlLang must still run alongside injection');
});

test('a 401 embeds an explicit guest, other failures leave the session unknown', async () => {
  const unauthorized: FetchCall[] = [];
  const guest = await renderDocument(documentRequest(), unauthorized, () =>
    Promise.resolve(new Response('{}', { status: 401 })),
  );
  assert.equal(payloadOf(guest.html).session, null);

  for (const me of [
    () => Promise.resolve(new Response('{}', { status: 503 })),
    () => Promise.reject(new Error('offline')),
  ]) {
    const calls: FetchCall[] = [];
    const { html } = await renderDocument(documentRequest(), calls, me);
    assert.ok(!('session' in payloadOf(html)), 'a transient failure must not claim a guest session');
  }
});

test('only document navigations trigger the session read', async () => {
  const cases: Array<{ name: string; request: Request }> = [
    {
      name: 'POST navigation',
      request: new Request('https://flaxia.app/home', { method: 'POST', headers: { 'sec-fetch-dest': 'document' } }),
    },
    {
      name: 'API path',
      request: new Request('https://flaxia.app/api/posts', { headers: { 'sec-fetch-dest': 'document' } }),
    },
    {
      name: 'WebSocket upgrade',
      request: new Request('https://flaxia.app/home', {
        headers: { 'sec-fetch-dest': 'document', upgrade: 'websocket' },
      }),
    },
    {
      name: 'data request',
      request: new Request('https://flaxia.app/home', { headers: { accept: 'application/json' } }),
    },
  ];
  for (const { name, request } of cases) {
    const calls: FetchCall[] = [];
    await renderDocument(request, calls);
    assert.ok(!calls.some((call) => call.path === '/api/me'), `${name} must not read /api/me`);
  }
});

test('HTML boot responses vary by Cookie when it is not already present', async () => {
  const calls: FetchCall[] = [];
  const { response } = await renderDocument(documentRequest(), calls);
  assert.match(response.headers.get('vary') ?? '', /Accept-Language/);
  assert.match(response.headers.get('vary') ?? '', /Cookie/);

  const existing = await withSecurityHeaders(
    new Response('html', { headers: { 'Content-Type': 'text/html', Vary: 'Accept-Language' } }),
  );
  assert.doesNotMatch(existing.headers.get('vary') ?? '', /Cookie/, 'non-boot responses keep their Vary policy');

  const json = await handle({
    event: bootEvent(documentRequest(), calls),
    resolve: () => Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } })),
  } as unknown as Parameters<typeof handle>[0]);
  assert.doesNotMatch(json.headers.get('vary') ?? '', /Cookie/, 'only HTML may vary by Cookie');
});

test('hooks.server.ts keeps the projection narrow and the navigation gate explicit', async () => {
  const source = await hookSource();
  assert.match(source, /export function safeJson/);
  assert.match(source, /export function injectBootData/);
  assert.match(source, /<!--FLAXIA_BOOT_DATA-->/);
  assert.match(source, /AbortSignal\.timeout\(1200\)/);
  assert.match(source, /event\.fetch\(['"]\/api\/me['"]/);
  assert.match(source, /sec-fetch-dest/, 'document navigations must be detected explicitly');
  assert.match(source, /['"]text\/html['"]/, 'older navigations send Accept: text/html');
  assert.match(source, /injectBootData\(/, 'transformPageChunk must inject the boot data');
  assert.match(source, /applyHtmlLang\(/, 'the html lang rewrite must stay in place');
  assert.match(source, /VARY_COOKIE/, 'HTML must vary by Cookie when session data is embedded');

  const fields = source.match(/const SESSION_FIELDS[^=]*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(fields, 'the allowlist must be visible in source');
  assert.deepEqual(
    [...fields[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
    ['id', 'username', 'display_name', 'avatar_key', 'badge_type', 'name_color'],
  );
  assert.doesNotMatch(source, /ng_words/, 'nsfw filter data must stay out of the HTML');
  assert.doesNotMatch(source, /srp[A-Z_]/, 'SRP fields must stay out of the HTML');
});

test('app.html holds the marker plus a static hashable reader script', async () => {
  const html = await appHtmlSource();
  const markerAt = html.indexOf(MARKER);
  assert.ok(markerAt >= 0, 'app.html must contain the SSR injection marker');
  assert.ok(markerAt < html.indexOf('Theme boot'), 'boot data must precede the theme script');

  const reader = html.match(/<script>([\s\S]*?__FLAXIA_BOOT__[\s\S]*?)<\/script>/);
  assert.ok(reader, 'app.html must carry a static reader script');
  for (const token of [
    "getElementById('__flaxia_boot__')",
    'JSON.parse',
    'window.__FLAXIA_LOCALE__',
    'window.__FLAXIA_SESSION__',
    'window.__FLAXIA_BOOT__',
    "'session' in data",
  ]) {
    assert.ok(reader[1].includes(token), `reader script is missing ${token}`);
  }
  assert.doesNotMatch(html, /%sveltekit\.nonce%/);
  assert.doesNotMatch(html, /unsafe-inline/);
  assert.ok(!html.includes('id="__flaxia_boot__"'), 'the JSON block is injected per request, not authored in app.html');
});

test('applyHtmlLang and injectBootData compose in either pipeline order', () => {
  const lang = applyHtmlLang(HTML, 'ja');
  const both = injectBootData(lang, LOCALE, null);
  assert.match(both, /<html lang="ja">/);
  assert.equal(payloadOf(both).locale.locale, 'ja');
});
