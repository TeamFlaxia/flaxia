// F4 guard: the Svelte i18n bridge must follow the legacy localechange event
// so both renderers switch language together.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get } from 'svelte/store';

test('Svelte stores follow the legacy localechange event', async () => {
  const win = new EventTarget();
  (globalThis as { window?: EventTarget }).window = win;

  const { locale, translate } = await import('../src/lib/i18n-svelte.ts');

  const event = new Event('localechange') as CustomEvent<{ locale: string }>;
  Object.defineProperty(event, 'detail', { value: { locale: 'en' } });
  win.dispatchEvent(event);

  assert.equal(get(locale), 'en');
  assert.equal(get(translate)('i18n.bridge.missing'), 'i18n.bridge.missing');
});
