// When hooks.server.ts injects SSR boot data the browser must hydrate from it
// with zero boot network requests: no locale JSON and no /api/me. The globals
// are read at module evaluation so onMount can adopt the real session without
// changing the SSR-safe render contract.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const globals = globalThis as unknown as {
  window?: Record<string, unknown>;
  document?: Record<string, unknown>;
  localStorage?: Record<string, unknown>;
  fetch: typeof fetch;
};
const originalWindow = globals.window;
const originalDocument = globals.document;
const originalLocalStorage = globals.localStorage;
const originalFetch = globals.fetch;

afterEach(() => {
  globals.window = originalWindow;
  globals.document = originalDocument;
  globals.localStorage = originalLocalStorage;
  globals.fetch = originalFetch;
});

function stubWindow(values: Record<string, unknown>): void {
  globals.window = { ...values, dispatchEvent: () => true };
}

/** Each import needs a fresh module instance because boot globals are read once. */
let moduleSerial = 0;
function bootModule(path: string): string {
  return `../${path}?boot=${moduleSerial++}`;
}

test('i18n reads the boot locale at module evaluation', async () => {
  const i18n = await read('src/lib/i18n.ts');
  const moduleScope = i18n.slice(0, i18n.indexOf('function getInitialLocale'));
  assert.match(moduleScope, /typeof window !== ['"]undefined['"]/);
  assert.match(moduleScope, /__FLAXIA_LOCALE__/);
  assert.match(moduleScope, /currentLocale\s*=/, 'boot locale must seed currentLocale');
  assert.match(moduleScope, /strings\s*=/, 'boot strings must seed the sync dictionary');
  assert.match(moduleScope, /fallbackStrings\s*=/, 'boot fallback must seed the sync dictionary');

  const init = i18n.slice(i18n.indexOf('export async function initI18n'));
  assert.match(init, /if \([^)]*[Bb]oot[^)]*\) return;/, 'initI18n must early-return on boot locale data');
  assert.ok(
    init.indexOf('return;') < init.indexOf('loadPromise'),
    'initI18n must return before starting any locale fetch',
  );
});

test('boot locale is adopted synchronously and initI18n performs no fetch', async () => {
  let fetches = 0;
  globals.fetch = async () => {
    fetches++;
    throw new Error('unexpected locale fetch during hydration');
  };
  stubWindow({
    __FLAXIA_BOOT__: true,
    __FLAXIA_LOCALE__: {
      locale: 'en',
      strings: { 'nav.home': 'Home', 'nav.settings': 'Settings' },
      fallback: { 'nav.home': 'Home', 'nav.settings': 'Settings' },
    },
  });

  const i18n = await import(bootModule('src/lib/i18n.ts'));
  assert.equal(i18n.getLocale(), 'en', 'boot locale must be visible before initI18n resolves');
  assert.equal(i18n.t('nav.home'), 'Home', 'boot strings must be usable during the first render');
  assert.equal(i18n.t('nav.settings'), 'Settings');
  await i18n.initI18n();
  assert.equal(fetches, 0, 'SSR boot data must eliminate the locale network gate');
});

test('a deliberate locale change still fetches and dispatches localechange', async () => {
  const fetched: string[] = [];
  globals.fetch = async (input) => {
    const url = String(input);
    fetched.push(url);
    return Response.json(url.includes('/ja.json') ? { 'nav.home': 'ホーム' } : { 'nav.home': 'Home' });
  };
  globals.document = { cookie: '', documentElement: { lang: 'en' } };
  globals.localStorage = { getItem: () => null, setItem: () => {} };
  stubWindow({
    __FLAXIA_BOOT__: true,
    __FLAXIA_LOCALE__: { locale: 'en', strings: { 'nav.home': 'Home' }, fallback: { 'nav.home': 'Home' } },
  });

  const i18n = await import(bootModule('src/lib/i18n.ts'));
  await i18n.initI18n();
  await i18n.setLocale('ja');
  assert.ok(
    fetched.some((url) => url.includes('/locales/ja.json')),
    'the chosen locale must be fetched',
  );
  assert.ok(
    fetched.some((url) => url.includes('/locales/en.json')),
    'the fallback must be fetched',
  );
  assert.equal(i18n.getLocale(), 'ja');
  assert.equal(i18n.t('nav.home'), 'ホーム');
});

test('session seeds the snapshot from the boot global at module evaluation', async () => {
  const session = await read('src/lib/svelte/session.ts');
  const moduleScope = session.slice(0, session.indexOf('export function getSessionUser'));
  assert.match(moduleScope, /typeof window !== ['"]undefined['"]/);
  assert.match(moduleScope, /__FLAXIA_SESSION__/);
  assert.match(moduleScope, /hasOwn|in window/, 'key presence must distinguish a guest from unknown');

  const load = session.slice(session.indexOf('export async function loadSessionUser'));
  assert.match(load, /return current/, 'boot data must short-circuit /api/me');
  assert.ok(
    load.indexOf('return current') < load.indexOf("import('../auth-cache.ts')"),
    'the boot return must happen before the network import',
  );
});

test('a boot session user is adopted synchronously without an auth request', async () => {
  const user = { id: 'alice', username: 'alice' };
  let fetches = 0;
  globals.fetch = async () => {
    fetches++;
    throw new Error('unexpected /api/me during hydration');
  };
  stubWindow({ __FLAXIA_BOOT__: true, __FLAXIA_SESSION__: user });

  const session = await import(bootModule('src/lib/svelte/session.ts'));
  assert.deepEqual(session.getSessionUser(), user, 'onMount must see the real user immediately');
  assert.deepEqual(await session.loadSessionUser(), user);
  assert.equal(fetches, 0, 'SSR boot data must eliminate the /api/me boot request');
});

test('an explicit boot null stays a guest without an auth request', async () => {
  let fetches = 0;
  globals.fetch = async () => {
    fetches++;
    throw new Error('unexpected /api/me during hydration');
  };
  stubWindow({ __FLAXIA_BOOT__: true, __FLAXIA_SESSION__: null });

  const session = await import(bootModule('src/lib/svelte/session.ts'));
  assert.equal(session.getSessionUser(), null, 'an explicit null boot session means guest');
  assert.equal(await session.loadSessionUser(), null);
  assert.equal(fetches, 0, 'a boot guest must not probe /api/me');
});

test('root layout skips the boot gate only when SSR boot data exists', async () => {
  const layout = await read('src/routes/+layout.ts');
  assert.match(layout, /export const ssr/);
  assert.match(layout, /export const prerender/);
  assert.match(layout, /import \{ bootShell \}/);
  assert.match(layout, /__FLAXIA_BOOT__/, 'the layout must detect the injected boot marker');
  assert.match(layout, /bootShell\(\)/);

  const bootAt = layout.indexOf('__FLAXIA_BOOT__');
  const awaitedAt = layout.indexOf('await bootShell()');
  assert.ok(bootAt >= 0 && awaitedAt > bootAt, 'the unconditional await must live in the fallback branch');
  const bootBranch = layout.slice(bootAt, awaitedAt);
  assert.match(bootBranch, /bootShell\(\)/, 'the boot branch must still start the shell helper');
  assert.doesNotMatch(bootBranch, /await\s+bootShell\(\)/, 'the boot branch must not await boot work');
  assert.match(bootBranch, /return \{\}/, 'the boot branch must return without a network gate');
  assert.match(layout, /await bootShell\(\)/, 'native/degraded SSR must keep the existing boot gate');
});
