// SSR post cards must follow the request locale instead of always shipping the
// English link label and a Japanese date. Unit tests cover the renderer and
// the request-scoped resolver; the last test checks the built SSR HTML.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type PostRow, renderPostArticle } from '../functions/lib/render-html.ts';
import { BASE_URL, seedUserAndLogin } from './helpers/setup.ts';

function post(): PostRow {
  return {
    id: 'locale-post',
    user_id: 'user-1',
    username: 'alice',
    display_name: 'Alice',
    avatar_key: null,
    text: 'localized card',
    hashtags: '[]',
    gif_key: null,
    payload_key: null,
    swf_key: null,
    thumbnail_key: null,
    fresh_count: 0,
    bookmark_count: 0,
    reply_count: 0,
    impressions: 0,
    parent_id: null,
    root_id: null,
    depth: 0,
    status: 'published',
    hidden: 0,
    created_at: '2026-01-02T12:00:00.000Z',
  };
}

test('renderPostArticle localizes the link label and date with an explicit locale', () => {
  const en = renderPostArticle(post(), 'https://flaxia.app', false, 'en');
  assert.match(en, />View post<\/a>/, 'English cards must say "View post"');
  assert.doesNotMatch(en, /年/, 'English cards must not use a Japanese date');

  const ja = renderPostArticle(post(), 'https://flaxia.app', false, 'ja');
  assert.match(ja, />投稿を見る<\/a>/, 'Japanese cards must have a Japanese link label');
  assert.match(ja, /<time[^>]*>20\d\d年/, 'Japanese cards must use a Japanese date');
  assert.notEqual(en, ja, 'the two locales must render different HTML');
});

test('renderPostArticle defaults to English without an explicit locale', () => {
  // functions/ must not import src/lib/i18n.ts, so the renderer takes the
  // locale explicitly; SsrPostCard passes the request-scoped one.
  const en = renderPostArticle(post(), 'https://flaxia.app');
  assert.match(en, />View post<\/a>/);
  assert.doesNotMatch(en, /年/);
});

test('SSR card source wires the request locale through to the renderer', async () => {
  const renderer = await readFile(new URL('../functions/lib/render-html.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /getLocale\(\)/, 'functions/ must not import browser-side src/lib/i18n');
  assert.match(renderer, /locale\s*=\s*['"]en['"]/, 'the renderer must accept an explicit locale');
  assert.doesNotMatch(renderer, /toLocaleDateString\(['"]ja-JP['"]\)/, 'dates must not be pinned to ja-JP');
  assert.doesNotMatch(renderer, />View post</, 'the link label must not be hard-coded to English');

  const card = await readFile(new URL('../src/lib/svelte/SsrPostCard.svelte', import.meta.url), 'utf8');
  assert.match(card, /getLocale\(\)/, 'SsrPostCard must read the request locale');
  assert.match(card, /renderPostArticle\([^)]*getLocale\(\)/, 'SsrPostCard must pass the locale to the renderer');
});

test('live: SSR HTML differs for Accept-Language: ja and en', async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const { cookie } = await seedUserAndLogin(`ssrloc${suffix}`);
  const id = crypto.randomUUID();
  const created = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId: id, text: `localization probe ${suffix}`, hashtags: [] }),
  });
  assert.equal(created.status, 200, await created.text());

  const en = await (await fetch(`${BASE_URL}/thread/${id}`, { headers: { 'Accept-Language': 'en' } })).text();
  const ja = await (await fetch(`${BASE_URL}/thread/${id}`, { headers: { 'Accept-Language': 'ja' } })).text();

  assert.match(en, />View post<\/a>/, 'Accept-Language: en must render the English link label');
  assert.doesNotMatch(en, /<time[^>]*>20\d\d年/, 'Accept-Language: en must not render a Japanese date');
  assert.match(ja, />投稿を見る<\/a>/, 'Accept-Language: ja must render the Japanese link label');
  assert.match(ja, /<time[^>]*>20\d\d年/, 'Accept-Language: ja must render a Japanese date');
});
