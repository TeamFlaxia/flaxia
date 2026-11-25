// Locale boot work must not block hydration, but the session snapshot is read
// synchronously by route components (settings, mail, auth guards) so it must
// still be awaited by the root universal load.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('root layout load does not await locale network work', async () => {
  const layout = await read('src/routes/+layout.ts');
  assert.match(layout, /export async function load\(/);
  assert.doesNotMatch(layout, /await Promise\.all\(\[\s*initI18n\(\)/);
  assert.doesNotMatch(layout, /await\s+initI18n\(\)/);
  assert.match(layout, /bootShell\(/);
});

test('root layout awaits boot before routes mount', async () => {
  const layout = await read('src/routes/+layout.ts');
  // Deferring locale/session made SSR text turn into translation keys and made
  // auth guards treat signed-in users as guests.
  assert.match(layout, /await bootShell\(\)/);
  const shell = await read('src/routes/+layout.svelte');
  // Remounting children on session arrival duplicates global nav elements.
  assert.doesNotMatch(shell, /\{#key sessionVersion\}/);
});

test('shell boot helper defers i18n but keeps the session loader callable', async () => {
  const helper = await read('src/lib/svelte/shell-boot.ts');
  assert.match(helper, /export function bootShell/);
  assert.match(helper, /initShellBootstrap\(\)/);
  assert.match(helper, /initI18n\(\)/);
  assert.match(helper, /loadSessionUser\(\)/);
});

test('root layout awaits locale boot in onMount', async () => {
  const layout = await read('src/routes/+layout.svelte');
  const onMountBlock = layout.slice(layout.indexOf('onMount('));
  assert.match(onMountBlock, /bootShell\(\)/);
});

test('session snapshot stays synchronous for components', async () => {
  const session = await read('src/lib/svelte/session.ts');
  assert.match(session, /export function getSessionUser\(\)/);
  assert.match(session, /loadSessionUser\(\)/);
});
