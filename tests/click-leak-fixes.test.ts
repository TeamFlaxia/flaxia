// Source-level regression guards for the accumulating document-click listener /
// Svelte-root leaks in the post card surfaces. These are structural checks: the
// affected code paths are browser-only DOM bridges that need a real document.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('ImagePreview has one removal observer that unmounts whichever root it mounted', async () => {
  const source = await read('src/components/ImagePreview.ts');

  assert.equal(
    source.match(/new MutationObserver\(/g)?.length ?? 0,
    1,
    'there must be exactly one removal observer at function scope',
  );
  const observerAt = source.indexOf('new MutationObserver(');
  assert.ok(
    observerAt >= 0 && observerAt < source.indexOf('mount(DataSaverPlaceholder'),
    'the observer must be installed before (and therefore cover) the data-saver branch',
  );
  assert.match(source, /instance\s*=\s*mount\(DataSaverPlaceholder/, 'the data-saver root must be tracked');
  assert.match(source, /instance\s*=\s*mount\(ImagePreview/, 'the normal image root must be tracked too');
  assert.match(
    source,
    /observer\s*=\s*new MutationObserver\(\(\) => \{[\s\S]*?unmount\(instance\)/,
    'the observer must unmount the tracked instance (including the data-saver one)',
  );
});

test('PostCard skips the deferred post-text mount when the card is already destroyed', async () => {
  const source = await read('src/lib/svelte/PostCard.svelte');
  const at = source.indexOf('queueMicrotask(() => {', source.indexOf('export function updatePost'));
  assert.ok(at >= 0, 'the updatePost microtask is missing');
  const body = source.slice(at, source.indexOf('});', at));

  assert.match(body, /cardDestroyed/, 'the microtask must re-check the card lifecycle');
  assert.match(body, /isConnected/, 'the microtask must not mount into a detached textHost');
  assert.match(body, /return/, 'a stale microtask must skip instead of mounting');
});

test('setupMenuCloseHandler returns a disposer that clears the pending timer', async () => {
  const source = await read('src/components/PostMenu.ts');
  const at = source.indexOf('export function setupMenuCloseHandler');
  assert.ok(at >= 0, 'setupMenuCloseHandler is missing');
  const fn = source.slice(at);

  assert.match(fn, /\):\s*\(\)\s*=>\s*void\s*\{/, 'the setup function must return a disposer');
  assert.match(fn, /clearTimeout\(/, 'disposing must cancel a not-yet-fired listener registration');
  assert.match(fn, /removeEventListener\(/, 'disposing must remove a listener that was added');
});

test('the dropdown destroy path reaches the close-handler cleanup', async () => {
  const source = await read('src/components/PostMenu.ts');
  const match = /\.destroy = \(\) => \{/.exec(source);
  assert.ok(match, 'the dropdown destroy hook is missing');
  const destroy = source.slice(match.index, source.indexOf('return dropdown;', match.index));

  assert.match(destroy, /dispose/i, 'destroying the dropdown must run the close-handler disposer');
});
