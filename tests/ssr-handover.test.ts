// SSR fallback markup stays visible until the interactive view has data (no
// blank-feed flash), but it must remain clickable during that window: the
// static cards have no JS handlers of their own.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { hasSsrHandover, SSR_HANDOVER_EVENT, signalSsrHandover } from '../src/lib/ssr-handover.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('signalling a handover dispatches a window event and is sticky', async () => {
  assert.equal(hasSsrHandover(), false);
  assert.equal(SSR_HANDOVER_EVENT, 'flaxia:ssr-handover');
  const dispatched: string[] = [];
  const previous = globalThis.window;
  // biome-ignore lint/suspicious/noExplicitAny: minimal window stub for a Node test
  (globalThis as any).window = { dispatchEvent: (event: Event) => dispatched.push(event.type) };
  try {
    signalSsrHandover();
    assert.deepEqual(dispatched, [SSR_HANDOVER_EVENT]);
    assert.equal(hasSsrHandover(), true);
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});

test('SSR-only components wait for the handover signal', async () => {
  for (const file of ['src/lib/svelte/SsrPostList.svelte', 'src/lib/svelte/SsrOnly.svelte']) {
    const source = await read(file);
    assert.match(source, /SSR_HANDOVER_EVENT/, `${file} must listen for handover`);
    assert.doesNotMatch(
      source,
      /onMount\(\(\)\s*=>\s*\{\s*handover\s*=\s*true;?\s*\}\)/,
      `${file} must not drop SSR markup unconditionally on mount`,
    );
  }
});

test('the SSR feed delegates post clicks to the thread route', async () => {
  const source = await read('src/lib/svelte/SsrPostList.svelte');
  assert.match(source, /onFeedClick/, 'must install a delegated click handler');
  assert.match(source, /data-ssr-post-id/, 'must identify the clicked post');
  assert.match(source, /navigate\(`\/thread\//, 'must navigate to the thread');
});

test('interactive views still signal a data-ready handover', async () => {
  for (const file of [
    'src/lib/svelte/Timeline.svelte',
    'src/lib/svelte/ThreadPage.svelte',
    'src/lib/svelte/ProfilePage.svelte',
    'src/lib/svelte/arcade/ArcadePage.svelte',
  ]) {
    const source = await read(file);
    assert.match(source, /signalSsrHandover\(\)/, `${file} must hand over from the SSR fallback`);
  }
});

test('post text links do not also trigger card navigation', async () => {
  const source = await read('src/lib/svelte/PostCard.svelte');
  assert.match(source, /\.hashtag-link/, 'card click guard must exclude hashtags');
  assert.match(source, /\.mention-link/, 'card click guard must exclude mentions');
});
