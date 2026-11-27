// Thread's root card is mounted imperatively before the route's onMount adopts
// the session. These guards keep the authoritative snapshot in that path.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('ThreadPage passes the synchronous session snapshot to imperative mounts', async () => {
  const source = await read('src/lib/svelte/ThreadPage.svelte');
  assert.match(source, /function activeUser\(\)/);
  assert.match(source, /currentUser \?\? getSessionUser\(\)/);
  assert.equal(
    (source.match(/currentUser: activeUser\(\)/g) ?? []).length,
    4,
    'root card, reply composer and replies must use the snapshot',
  );
  const markup = source.slice(source.indexOf('</script>'));
  assert.doesNotMatch(markup, /activeUser\(\)/, 'markup must not read the client-only session during render');
});

test('PostCard auth gates consult the session singleton at click time', async () => {
  const source = await read('src/lib/svelte/PostCard.svelte');
  assert.match(source, /getSessionUser\(\) \|\| props\.currentUser/);
  assert.match(source, /currentUser: getSessionUser\(\) \?\? props\.currentUser/);
});

test('ReplyComposer falls back to the session singleton for its viewer', async () => {
  const source = await read('src/lib/svelte/ReplyComposer.svelte');
  assert.match(source, /function activeUser\(\): CurrentUser \| null/);
  assert.match(source, /currentUser \?\? getSessionUser\(\)/);
});

test('root layout keeps the boot gate when the session key is missing', async () => {
  const layout = await read('src/routes/+layout.ts');
  const bootAt = layout.indexOf('__FLAXIA_BOOT__');
  const awaitedAt = layout.indexOf('await bootShell()');
  assert.ok(bootAt >= 0 && awaitedAt > bootAt);
  const bootBranch = layout.slice(bootAt, awaitedAt);
  assert.match(bootBranch, /__FLAXIA_SESSION__' in bootWindow/);
  assert.doesNotMatch(bootBranch, /await bootShell\(\)/);
});
