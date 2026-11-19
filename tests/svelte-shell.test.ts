// F5 shell infrastructure: Svelte wrappers must mount/dispose the legacy nav
// so F6-F8 pages can adopt them without duplicating behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Svelte left nav wraps the legacy component', async () => {
  const source = await read('src/lib/svelte/LeftNav.svelte');
  assert.match(source, /createLeftNav/);
  assert.match(source, /host\.replaceChildren/);
  assert.match(source, /nav\??\.destroy/);
});

test('Svelte right panel wraps the legacy component', async () => {
  const source = await read('src/lib/svelte/RightPanel.svelte');
  assert.match(source, /createRightPanel/);
  assert.match(source, /host\.replaceChildren/);
  assert.match(source, /panel\??\.destroy/);
});

test('shell wrappers do not become flex items', async () => {
  for (const file of ['LeftNav.svelte', 'RightPanel.svelte']) {
    const source = await read(`src/lib/svelte/${file}`);
    assert.match(source, /display: contents/, `${file} wrapper must not take flex space`);
  }
});

test('left nav rebuilds when auth props arrive', async () => {
  const source = await read('src/lib/svelte/LeftNav.svelte');
  assert.match(source, /\$effect/);
  assert.match(source, /createLeftNav\(next\)/);
  assert.match(source, /host\.replaceChildren/);
});

test('shell layout keeps the three-column landmark structure', async () => {
  const source = await read('src/lib/svelte/ShellLayout.svelte');
  assert.match(source, /class="main-container"/);
  assert.match(source, /role="main"/);
  assert.match(source, /<LeftNav/);
  assert.match(source, /<RightPanel/);
});
