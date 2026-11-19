// F7 regression guard: feed reorder/filter must move existing post cards
// instead of rebuilding them, otherwise a running game iframe reloads and the
// player loses state. Added before any Feed/Thread migration to SvelteKit.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const timeline = await readFile(new URL('../src/components/Timeline.ts', import.meta.url), 'utf8');

test('feed refresh reuses post cards and moves only out-of-place nodes', () => {
  assert.match(timeline, /const reusable = new Map/, 'existing cards must be collected for reuse');
  assert.match(timeline, /if \(node === cursor\)/, 'cards already in place must not be re-inserted');
  assert.match(timeline, /postList\.insertBefore\(node, cursor\)/, 'reorder must move live DOM nodes');
  assert.match(timeline, /Keep the card \(and any live iframe\)/, 'the live-iframe invariant must be documented');
});

test('feed refresh never nukes the post list innerHTML', () => {
  assert.doesNotMatch(timeline, /postList\.innerHTML\s*=/, 'innerHTML replacement would reload every iframe');
  assert.doesNotMatch(timeline, /replaceChildren\(/, 'replaceChildren would destroy running game iframes');
});

test('a card is destroyed only when it leaves the feed', () => {
  const dropBlock = /Drop cards that left the feed[\s\S]{0,600}this\.postCards\.get\(id\)\?\.destroy\(\)/;
  assert.match(timeline, dropBlock, 'destroy must be limited to removed posts');
});
