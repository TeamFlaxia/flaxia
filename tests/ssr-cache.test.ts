// SSR HTML is built with the viewer's Cookie/Authorization (SvelteKit forwards
// them to the internal API), so no SSR page may advertise shared caching.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const FILES = [
  'src/routes/home/+page.ts',
  'src/routes/thread/[id]/+page.ts',
  'src/routes/users/[username]/+page.ts',
  'src/routes/arcade/+page.ts',
  'src/routes/arcade/[id]/+page.ts',
];

test('all SSR data loads use private, no-store', async () => {
  for (const file of FILES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(
      source,
      /setHeaders\(\{ 'Cache-Control': 'private, no-store' \}\)/,
      `${file} must disable shared caching`,
    );
    assert.doesNotMatch(source, /s-maxage/, `${file} must not advertise an edge cache lifetime`);
  }
});

test('the SSR hook applies a central private/no-store policy to HTML', async () => {
  const hook = await readFile(new URL('../src/hooks.server.ts', import.meta.url), 'utf8');
  assert.match(hook, /text\/html/, 'the cache policy must be limited to HTML responses');
  assert.match(hook, /headers\.has\(['"]cache-control['"]\)/, 'an explicit Cache-Control must be respected');
  assert.match(hook, /['"]private, no-store['"]/, 'HTML without Cache-Control must not be shared');

  // The hook is not allowed to override the five data routes that already set
  // their own header; those are covered by the behavioural tests in
  // tests/ssr-hooks.test.ts and the per-route assertions above.
  assert.doesNotMatch(
    hook,
    /headers\.set\(['"]cache-control['"], ['"]public/,
    'SSR HTML must never opt in to shared caching',
  );
});
