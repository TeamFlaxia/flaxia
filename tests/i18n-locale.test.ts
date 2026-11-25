// SSR picks the locale from the flaxia_locale cookie; the browser must prefer
// that same cookie on first load or Japanese SSR text flips to English at
// hydration. Keep one cookie parser for both sides.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { localeFromCookie } from '../src/lib/i18n.ts';

test('locale cookie parsing is safe and limited to supported locales', () => {
  assert.equal(localeFromCookie('flaxia_locale=ja'), 'ja');
  assert.equal(localeFromCookie('a=1; flaxia_locale=en; b=2'), 'en');
  assert.equal(localeFromCookie('flaxia_locale=%E6%97%A5'), null);
  assert.equal(localeFromCookie('flaxia_locale=%'), null);
  assert.equal(localeFromCookie('other=ja'), null);
  assert.equal(localeFromCookie(''), null);
});

test('both server and browser use the shared cookie parser', async () => {
  const i18n = await readFile(new URL('../src/lib/i18n.ts', import.meta.url), 'utf8');
  const browserInit = i18n.slice(
    i18n.indexOf('function getInitialLocale'),
    i18n.indexOf('async function loadLocaleFile'),
  );
  assert.match(browserInit, /localeFromCookie\(/, 'browser must read the SSR locale cookie first');
  assert.ok(
    browserInit.indexOf('localeFromCookie(') < browserInit.indexOf('localStorage.getItem'),
    'cookie must win over localStorage so hydration matches SSR',
  );

  const hook = await readFile(new URL('../src/hooks.server.ts', import.meta.url), 'utf8');
  assert.match(hook, /localeFromCookie\(/, 'SSR hook must use the same cookie parser');
});

test('SSR persists the negotiated locale in the cookie and varies HTML by Accept-Language', async () => {
  const hook = await readFile(new URL('../src/hooks.server.ts', import.meta.url), 'utf8');
  assert.match(hook, /cookies\.set\(\s*['"]flaxia_locale['"]/, 'SSR must persist the negotiated locale');
  assert.match(hook, /Accept-Language/, 'HTML must vary by the header used to negotiate the locale');
  assert.match(hook, /['"]text\/html['"]/, 'Vary must only apply to HTML responses');

  // Behavioural coverage (cookie issuance, malformed cookies, no 500) lives in
  // tests/ssr-hooks.test.ts; this guard keeps the SSR/browser contract visible
  // next to the shared cookie parser.
  const i18n = await readFile(new URL('../src/lib/i18n.ts', import.meta.url), 'utf8');
  const setLocale = i18n.slice(i18n.indexOf('export async function setLocale'), i18n.indexOf('export function t('));
  assert.match(setLocale, /document\.cookie/, 'browser locale changes must mirror back to the SSR cookie');
});
