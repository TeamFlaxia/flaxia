// Boot work must not block hydration. The root universal load used to await
// two network operations (locale files + /api/me) before ANY route component
// could mount, leaving fully-rendered SSR markup with zero click handlers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('root layout load does not await boot network work', async () => {
  const layout = await read('src/routes/+layout.ts');
  assert.match(layout, /export (?:async )?function load\(/);
  // These awaits are the hydration gate; they must be gone from load().
  assert.doesNotMatch(layout, /await Promise\.all\(\[\s*initI18n\(\)/);
  assert.doesNotMatch(layout, /await\s+loadSessionUser\(\)/);
  // Boot is started fire-and-forget and completed in onMount instead.
  assert.match(layout, /bootShell\(/);
});

test('shell boot helper defers i18n and session until after mount', async () => {
  const helper = await read('src/lib/svelte/shell-boot.ts');
  assert.match(helper, /export function bootShell/);
  assert.match(helper, /initShellBootstrap\(\)/);
  assert.match(helper, /initI18n\(\)/);
  assert.match(helper, /loadSessionUser\(\)/);
  // The helper itself must never be awaited from the root load.
  assert.doesNotMatch(helper, /window\.location\.href\s*=/);
});

test('root layout awaits shell boot in onMount', async () => {
  const layout = await read('src/routes/+layout.svelte');
  const onMountBlock = layout.slice(layout.indexOf('onMount('));
  assert.match(onMountBlock, /bootShell\(\)/);
  // Route components read the session once on mount; remount them once the
  // deferred session resolution settles so signed-in users are not guests.
  assert.match(layout, /sessionVersion/);
  assert.match(layout, /\{#key sessionVersion\}/);
});

test('session snapshot stays synchronous for components', async () => {
  const session = await read('src/lib/svelte/session.ts');
  assert.match(session, /export function getSessionUser\(\)/);
  assert.match(session, /loadSessionUser\(\)/);
});
