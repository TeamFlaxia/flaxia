import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyHtmlLang,
  handle,
  isPreviewHostname,
  loadLocale,
  pickLocale,
  withSecurityHeaders,
} from '../src/hooks.server.ts';
import { t } from '../src/lib/i18n.ts';

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://flaxia.app/home', { headers });
}

function localeFetch(input: string | URL | Request): Promise<Response> {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
  const strings = path === '/locales/ja.json' ? { home_title: 'ホーム' } : { home_title: 'Home' };
  return Promise.resolve(new Response(JSON.stringify(strings), { headers: { 'Content-Type': 'application/json' } }));
}

function htmlResponse(body = '<!DOCTYPE html><html lang="en"><head></head><body></body></html>'): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function htmlHeaders(): Record<string, string> {
  return { 'Content-Type': 'text/html; charset=utf-8' };
}

test('isPreviewHostname blocks Cloudflare Pages preview domains only', () => {
  assert.equal(isPreviewHostname('abc123.pages.dev'), true);
  assert.equal(isPreviewHostname('preview-123.flaxia.pages.dev'), true);
  assert.equal(isPreviewHostname('flaxia.app'), false);
  assert.equal(isPreviewHostname('notpages.dev'), false);
  assert.equal(isPreviewHostname('pages.dev.example.com'), false);
});

test('isPreviewHostname tolerates case, a trailing dot and malformed input', () => {
  assert.equal(isPreviewHostname('ABC123.PAGES.DEV'), true);
  assert.equal(isPreviewHostname('abc123.pages.dev.'), true);
  assert.equal(isPreviewHostname('  abc123.pages.dev  '), true);
  assert.equal(isPreviewHostname(''), false);
  assert.equal(isPreviewHostname(null as unknown as string), false);
  assert.equal(isPreviewHostname(undefined as unknown as string), false);
  assert.equal(isPreviewHostname(42 as unknown as string), false);
});

test('pickLocale accepts a valid locale cookie over Accept-Language', () => {
  assert.equal(pickLocale(requestWith({ cookie: 'flaxia_locale=ja', 'accept-language': 'en-US,en;q=0.9' })), 'ja');
  assert.equal(pickLocale(requestWith({ cookie: 'other=1; flaxia_locale=en', 'accept-language': 'ja' })), 'en');
  assert.equal(pickLocale(requestWith({ cookie: 'flaxia_locale=%6a%61' })), 'ja');
  assert.equal(pickLocale(requestWith({ cookie: 'flaxia_locale=fr' })), 'en');
});

test('pickLocale never throws on malformed percent-encoding and falls back', () => {
  assert.equal(pickLocale(requestWith({ cookie: 'flaxia_locale=%' })), 'en');
  assert.equal(pickLocale(requestWith({ cookie: 'flaxia_locale=%ZZ' })), 'en');
  assert.equal(pickLocale(requestWith({ cookie: 'flaxia_locale=%E6%97', 'accept-language': 'ja,en;q=0.9' })), 'ja');
});

test('pickLocale falls back to Accept-Language when no cookie is present', () => {
  assert.equal(pickLocale(requestWith({ 'accept-language': 'ja,en;q=0.9' })), 'ja');
  assert.equal(pickLocale(requestWith({ 'accept-language': 'ja-JP' })), 'ja');
  assert.equal(pickLocale(requestWith({ 'accept-language': 'en-US,en;q=0.9' })), 'en');
  assert.equal(pickLocale(requestWith({})), 'en');
});

test('applyHtmlLang rewrites only the opening html tag', () => {
  const html =
    '<!DOCTYPE html>\n<html lang="en">\n<head><title>lang="en" in text</title></head>\n<body><div lang="en">hello</div></body>\n</html>';
  assert.equal(applyHtmlLang(html, 'ja'), html.replace('<html lang="en">', '<html lang="ja">'));
});

test('applyHtmlLang leaves documents without the default tag untouched', () => {
  const html = '<!DOCTYPE html>\n<html lang="ja">\n<head><title>既に日本語</title></head>\n<body>本文</body>\n</html>';
  assert.equal(applyHtmlLang(html, 'ja'), html);
  assert.equal(applyHtmlLang(html, 'en'), html);
});

test('handle serves a noindex 404 on preview hosts without resolving the page', async () => {
  const request = new Request('https://preview-123.flaxia.pages.dev/home');
  const response = await handle({
    event: {
      url: new URL(request.url),
      request,
      fetch: async () => new Response('{}'),
    },
    resolve: () => {
      throw new Error('resolve must not be called for preview hosts');
    },
  } as unknown as Parameters<typeof handle>[0]);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('handle applies the SSR locale to both the html tag and translations', async () => {
  const request = new Request('https://flaxia.app/home', {
    headers: { cookie: 'flaxia_locale=ja', 'accept-language': 'en-US,en;q=0.9' },
  });
  const response = await handle({
    event: {
      url: new URL(request.url),
      request,
      fetch: localeFetch,
      cookies: { set: () => undefined, get: () => undefined, delete: () => undefined },
    },
    resolve: (
      _event: unknown,
      opts?: { transformPageChunk?: (chunk: { html: string; done: boolean }) => string | Promise<string> },
    ) => {
      const html = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Flaxia</title></head>\n<body></body>\n</html>';
      const transformed = opts?.transformPageChunk?.({ html, done: true }) ?? html;
      return Promise.resolve(new Response(`${transformed}|${t('home_title')}`));
    },
  } as unknown as Parameters<typeof handle>[0]);

  const body = await response.text();
  assert.match(body, /<html lang="ja">/);
  assert.doesNotMatch(body, /<html lang="en">/);
  assert.match(body, /ホーム/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

function cookieEvent(request: Request, fetchImpl: typeof fetch = localeFetch) {
  const setCalls: Array<{ name: string; value: string; options?: unknown }> = [];
  const event = {
    url: new URL(request.url),
    request,
    fetch: fetchImpl,
    cookies: {
      set: (name: string, value: string, options?: unknown) => setCalls.push({ name, value, options }),
      get: () => undefined,
      delete: () => undefined,
    },
  };
  return { event, setCalls };
}

function resolveHtml(
  _event: unknown,
  opts?: { transformPageChunk?: (chunk: { html: string; done: boolean }) => string | Promise<string> },
): Promise<Response> {
  const html = '<!DOCTYPE html>\n<html lang="en">\n<head></head>\n<body></body>\n</html>';
  const transformed = opts?.transformPageChunk?.({ html, done: true }) ?? html;
  return Promise.resolve(new Response(String(transformed), { headers: htmlHeaders() }));
}

test('handle issues flaxia_locale from Accept-Language when the cookie is absent', async () => {
  const request = requestWith({ 'accept-language': 'ja,en;q=0.9' });
  const { event, setCalls } = cookieEvent(request);
  const response = await handle({ event, resolve: resolveHtml } as unknown as Parameters<typeof handle>[0]);

  assert.deepEqual(
    setCalls.map(({ name, value }) => [name, value]),
    [['flaxia_locale', 'ja']],
  );
  assert.equal(response.headers.get('vary'), 'Accept-Language');
});

test('handle does not set a locale cookie on API or WebSocket upgrade requests', async () => {
  for (const url of ['https://flaxia.app/api/ws/notifications', 'https://flaxia.app/api/posts']) {
    const request = new Request(url, {
      headers: { 'accept-language': 'ja', ...(url.includes('/ws/') ? { upgrade: 'websocket' } : {}) },
    });
    const { event, setCalls } = cookieEvent(request);
    await handle({
      event,
      resolve: () => Promise.resolve(new Response('ok')),
    } as unknown as Parameters<typeof handle>[0]);
    assert.deepEqual(setCalls, [], `${new URL(url).pathname} must not receive a Set-Cookie`);
  }
});

test('handle keeps an existing locale cookie and still varies HTML by Accept-Language', async () => {
  const request = requestWith({ cookie: 'flaxia_locale=en', 'accept-language': 'ja' });
  const { event, setCalls } = cookieEvent(request);
  const response = await handle({ event, resolve: resolveHtml } as unknown as Parameters<typeof handle>[0]);

  assert.deepEqual(setCalls, []);
  assert.equal(response.headers.get('vary'), 'Accept-Language');
});

test('handle tolerates a malformed locale cookie without a 500', async () => {
  const request = requestWith({ cookie: 'flaxia_locale=%', 'accept-language': 'ja' });
  const { event, setCalls } = cookieEvent(request);
  const response = await handle({ event, resolve: resolveHtml } as unknown as Parameters<typeof handle>[0]);

  assert.equal(response.status, 200);
  assert.equal(setCalls[0]?.value, 'ja');
  assert.equal(response.headers.get('vary'), 'Accept-Language');
});

test('handle still renders when a locale file cannot be loaded', async () => {
  const request = requestWith({ cookie: 'flaxia_locale=ja' });
  const { event } = cookieEvent(request, async () => {
    throw new Error('locale store unavailable');
  });
  const response = await handle({
    event,
    resolve: resolveHtml,
  } as unknown as Parameters<typeof handle>[0]);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html lang="ja">/);
});

test('locale cache retries a failed load and caches only the successful one', async () => {
  let attempts = 0;
  const failingFetch = async () => {
    attempts += 1;
    throw new Error('offline');
  };
  await assert.rejects(loadLocale('retry-locale', failingFetch));
  const failedAttempts = attempts;
  assert.ok(failedAttempts >= 1, 'the first load must actually try to fetch');

  const successFetch: typeof fetch = async (input) => {
    attempts += 1;
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    const strings = path === '/locales/retry-locale.json' ? { title: 'retried' } : { title: 'en' };
    return new Response(JSON.stringify(strings), { headers: { 'Content-Type': 'application/json' } });
  };
  const data = await loadLocale('retry-locale', successFetch);
  assert.equal(data.strings.title, 'retried');
  assert.equal(data.fallback.title, 'en');
  assert.ok(attempts > failedAttempts, 'a failed read must not be cached forever');

  const cachedAt = attempts;
  await loadLocale('retry-locale', successFetch);
  assert.equal(attempts, cachedAt, 'a successful load must be cached');
});

test('withSecurityHeaders varies HTML by Accept-Language and defaults to private no-store', () => {
  const html = withSecurityHeaders(htmlResponse());
  assert.equal(html.headers.get('vary'), 'Accept-Language');
  assert.equal(html.headers.get('cache-control'), 'private, no-store');
  assert.equal(html.headers.get('x-frame-options'), 'DENY');

  const withVary = new Response('html', { headers: { 'Content-Type': 'text/html', Vary: 'Accept-Encoding' } });
  assert.match(withSecurityHeaders(withVary).headers.get('vary') ?? '', /Accept-Encoding.*Accept-Language/);

  const alreadyVaried = new Response('html', { headers: { 'Content-Type': 'text/html', Vary: 'Accept-Language' } });
  assert.equal(withSecurityHeaders(alreadyVaried).headers.get('vary'), 'Accept-Language');
});

test('withSecurityHeaders respects an explicit Cache-Control and leaves non-HTML responses alone', () => {
  const explicit = new Response('html', {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' },
  });
  assert.equal(withSecurityHeaders(explicit).headers.get('cache-control'), 'public, max-age=60');

  const json = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  const result = withSecurityHeaders(json);
  assert.equal(result.headers.get('cache-control'), null);
  assert.equal(result.headers.get('vary'), null);
});
