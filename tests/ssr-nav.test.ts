// SSR nav highlighting must come from the request URL, not window.location.
// ShellLayout's synchronous fallback currently calls parseCurrentRoute(), which
// is undefined on the server and therefore highlights Home for every page.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const BASE_URL = process.env.FLAXIA_SSR_URL || 'http://localhost:8788';

test('ShellLayout derives its SSR fallback from the current URL', async () => {
  const source = await readFile(new URL('../src/lib/svelte/ShellLayout.svelte', import.meta.url), 'utf8');
  const fallback = source.slice(source.indexOf('const fallbackNavProps'), source.indexOf('void fallbackNavProps'));
  assert.match(
    fallback,
    /parseRoute\(page\.url\.pathname, page\.url\.search\)/,
    'use the pure route parser with the request URL',
  );
  assert.doesNotMatch(fallback, /parseCurrentRoute\(\)/, 'window.location is unavailable during SSR');
});

test('SSR highlights the nav item for the requested page', async (t) => {
  try {
    await fetch(`${BASE_URL}/home`, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    t.skip(`SSR test server is unreachable: ${(error as Error).message}`);
    return;
  }

  const arcade = await (await fetch(`${BASE_URL}/arcade`)).text();
  assert.match(
    arcade,
    /<button[^>]*data-nav-id="arcade"[^>]*aria-current="page"/,
    '/arcade must highlight Arcade in the server-rendered nav',
  );

  const maps = await (await fetch(`${BASE_URL}/maps`)).text();
  assert.doesNotMatch(
    maps,
    /<button[^>]*data-nav-id="home"[^>]*aria-current="page"/,
    '/maps must not highlight Home in the server-rendered nav',
  );
});
