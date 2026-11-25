// Hydration regression guard: universal +page.ts loads must return the same
// data on the client as they do during SSR. SvelteKit re-runs universal load
// on hydration and replaces the serialized server result, so a `browser`
// branch erases the SSR feed (and causes a content flash). Only the native
// static build (ssr = false) may short-circuit to empty data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const pageLoads = [
  'src/routes/home/+page.ts',
  'src/routes/thread/[id]/+page.ts',
  'src/routes/users/[username]/+page.ts',
  'src/routes/arcade/+page.ts',
  'src/routes/arcade/[id]/+page.ts',
] as const;

const sources = async (): Promise<Array<{ file: string; source: string }>> =>
  Promise.all(
    pageLoads.map(async (file) => ({
      file,
      source: await readFile(new URL(`../${file}`, import.meta.url), 'utf8'),
    })),
  );

test('universal page loads do not gate SSR data behind browser detection', async () => {
  for (const { file, source } of await sources()) {
    assert.doesNotMatch(source, /\$app\/env/, `${file} must not import $app/env`);
    assert.doesNotMatch(source, /if\s*\(\s*browser\s*\)/, `${file} must not branch on browser`);
  }
});

test('native static builds still short-circuit the SSR-only loads', async () => {
  for (const { file, source } of await sources()) {
    assert.match(
      source,
      /import\.meta\.env\.BUILD_TARGET\s*===\s*'native'/,
      `${file} must gate empty data on the native build only`,
    );
    assert.match(
      source,
      /if\s*\(\s*import\.meta\.env\.BUILD_TARGET\s*===\s*'native'\s*\)\s*return\s*\{/,
      `${file} must early-return empty data for the native build`,
    );
  }
});

test('web loads keep cache headers and not-found handling', async () => {
  const notFoundRoutes = new Set([
    'src/routes/thread/[id]/+page.ts',
    'src/routes/users/[username]/+page.ts',
    'src/routes/arcade/[id]/+page.ts',
  ]);
  for (const { file, source } of await sources()) {
    assert.match(source, /setHeaders\(/, `${file} must keep its Cache-Control header`);
    if (notFoundRoutes.has(file)) {
      assert.match(source, /error\(404/, `${file} must keep its 404 check`);
    }
  }
});
