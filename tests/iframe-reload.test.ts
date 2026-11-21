// F7 regression guard: feed reorder/filter must move existing post cards
// instead of rebuilding them, otherwise a running game iframe reloads and the
// player loses state.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const timeline = await readFile(new URL('../src/lib/svelte/Timeline.svelte', import.meta.url), 'utf8');
const cardHost = await readFile(new URL('../src/lib/timeline/CardHost.svelte', import.meta.url), 'utf8');

test('the feed renders keyed cards so reordering does not remount them', () => {
  assert.match(timeline, /\{#each items as item \(item\.id\)\}/, 'cards must be keyed by post id');
  assert.doesNotMatch(timeline, /\.innerHTML\s*=/, 'innerHTML replacement would reload every iframe');
});

test('CardHost owns one mounted card and destroys it only on removal', () => {
  assert.match(cardHost, /mountPostCard\(host, item, options\)/);
  assert.match(cardHost, /return \(\) => handle\?\.destroy\(\)/, 'the card is destroyed when its host unmounts');
});
