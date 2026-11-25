// On error responses the root layout must not emit its own title/meta/JSON-LD:
// +error.svelte owns the head so crawlers see exactly one title and noindex.
// page.status must only be read while rendering the head, never at module level
// (Svelte throws state_read_outside_render in dev for the latter).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('layout yields the head to +error.svelte on 4xx/5xx responses', async () => {
  const source = await readFile(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
  const script = source.match(/<script[\s\S]*?<\/script>/)?.[0] ?? '';
  assert.doesNotMatch(script, /page\.status/, 'no top-level page.status read');
  const head = source.slice(source.indexOf('<svelte:head>'), source.indexOf('</svelte:head>'));
  assert.match(head, /\{#if\s+page\.status\s*<\s*400\}/, 'title/meta/JSON-LD must be guarded on error responses');
});
