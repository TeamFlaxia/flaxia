import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHtmlLang, handle, isPreviewHostname, pickLocale } from '../src/hooks.server.ts';
import { t } from '../src/lib/i18n.ts';

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://flaxia.app/home', { headers });
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
      fetch: async (input: string | URL | Request) => {
        const path =
          typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
        if (path === '/locales/ja.json') {
          return new Response(JSON.stringify({ home_title: 'ホーム' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (path === '/locales/en.json') {
          return new Response(JSON.stringify({ home_title: 'Home' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}');
      },
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
