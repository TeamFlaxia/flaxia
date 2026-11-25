// SSR renders translations through the AsyncLocalStorage-backed localeResolver
// that hooks.server.ts installs. getLocale() must consult that same resolver so
// locale-dependent markup (nav labels, <html lang>, titles) matches t() during
// SSR instead of falling back to the module's browser default ('ja').
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLocale, setLocaleResolver } from '../src/lib/i18n.ts';

test('getLocale() uses the request-scoped resolver when one is active', () => {
  setLocaleResolver(() => ({ locale: 'en', strings: {}, fallback: {} }));
  try {
    assert.equal(getLocale(), 'en');
  } finally {
    setLocaleResolver(null);
  }
});

test('getLocale() falls back to the module default when no resolver is active', () => {
  setLocaleResolver(null);
  assert.equal(getLocale(), 'ja');
});
