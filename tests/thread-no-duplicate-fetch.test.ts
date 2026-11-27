// The thread route load paints root + replies immediately, but the interactive
// view must revalidate that data on mount: it can come from a prefetch or a
// short-lived cache and would otherwise show an old game version.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('ThreadPage accepts the route-loaded thread as initial data', async () => {
  const component = await read('src/lib/svelte/ThreadPage.svelte');
  assert.match(component, /initialRoot/, 'ThreadPage must accept initialRoot');
  assert.match(component, /initialReplies/, 'ThreadPage must accept initialReplies');
  const load = component.slice(component.indexOf('async function loadThread'));
  assert.match(load, /initialRoot/, 'loadThread must consume the route data');
});

test('thread route passes its loaded data into ThreadPage', async () => {
  const route = await read('src/routes/thread/[id]/+page.svelte');
  assert.match(route, /initialRoot=\{data\.root\}/);
  assert.match(route, /initialReplies=\{data\.replies\}/);
});
