// F5 shell infrastructure: Svelte wrappers must mount/dispose the legacy nav
// so F6-F8 pages can adopt them without duplicating behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Svelte left nav wraps the legacy component', async () => {
  const source = await read('src/lib/svelte/LeftNav.svelte');
  assert.match(source, /createLeftNav/);
  assert.match(source, /host\.appendChild/);
  assert.match(source, /dispose = nav\.destroy/);
  assert.match(source, /initI18n/);
});

test('Svelte right panel wraps the legacy component', async () => {
  const source = await read('src/lib/svelte/RightPanel.svelte');
  assert.match(source, /createRightPanel/);
  assert.match(source, /host\.appendChild/);
  assert.match(source, /dispose = panel\.destroy/);
});
