// On error responses the root layout must not emit its own title/meta/JSON-LD:
// +error.svelte owns the head so crawlers see exactly one title and noindex.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('layout yields the head to +error.svelte on 4xx/5xx responses', async () => {
  const source = await readFile(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
  assert.match(source, /page\.status\s*>=\s*400/, 'layout must detect error responses');
  const head = source.slice(source.indexOf('<svelte:head>'), source.indexOf('</svelte:head>'));
  assert.match(head, /\{#if !isError\}/, 'title/meta/JSON-LD must be guarded on error responses');
});
