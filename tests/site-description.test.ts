// The root layout localizes its generic description through t('site.description').
// Without the key in both locale files it silently falls back to English copy.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setLocaleResolver, t } from '../src/lib/i18n.ts';

async function localeStrings(locale: 'en' | 'ja'): Promise<Record<string, string>> {
  return JSON.parse(await readFile(new URL(`../public/locales/${locale}.json`, import.meta.url), 'utf8')) as Record<
    string,
    string
  >;
}

test('both locales define a distinct site.description', async () => {
  const en = await localeStrings('en');
  const ja = await localeStrings('ja');

  assert.ok(Object.hasOwn(en, 'site.description'), 'en.json must define site.description');
  assert.ok(Object.hasOwn(ja, 'site.description'), 'ja.json must define site.description');
  assert.equal(typeof en['site.description'], 'string');
  assert.equal(typeof ja['site.description'], 'string');
  assert.ok((en['site.description'] ?? '').length > 0);
  assert.ok((ja['site.description'] ?? '').length > 0);
  assert.notEqual(en['site.description'], ja['site.description'], 'the Japanese description must not be English');
  assert.match(en['site.description'] ?? '', /playable/i);
  assert.match(ja['site.description'] ?? '', /[ぁ-んァ-ヶ一-龯]/u);
});

test('t("site.description") resolves to the loaded locale copy, not the key', async () => {
  const en = await localeStrings('en');
  const ja = await localeStrings('ja');

  try {
    setLocaleResolver(() => ({ locale: 'en', strings: en, fallback: en }));
    assert.equal(t('site.description'), en['site.description']);
    setLocaleResolver(() => ({ locale: 'ja', strings: ja, fallback: en }));
    assert.equal(t('site.description'), ja['site.description']);
  } finally {
    setLocaleResolver(null);
  }
});

test('the root layout uses site.description for description and social tags', async () => {
  const layout = await readFile(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
  assert.match(layout, /\bt\(['"]site\.description['"]\)/, 'the layout must localize the description');

  const head = layout.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? '';
  assert.match(head, /name="description"\s+content=\{siteDescription\(\)\}/);
  assert.match(head, /property="og:description"\s+content=\{siteDescription\(\)\}/);
  assert.match(head, /name="twitter:description"\s+content=\{siteDescription\(\)\}/);
});
