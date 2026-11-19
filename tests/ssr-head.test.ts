// F2 guard: SEO routes reuse the exact head tags generated from the
// SvelteKit build, so static and SSR pages cannot silently diverge.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SPA_HEAD_TAGS } from '../functions/lib/ssr-head.generated.ts';

test('SvelteKit build head tags are generated from the static shell', () => {
  assert.match(SPA_HEAD_TAGS, /\/_app\/immutable\/entry\/start\./);
  assert.match(SPA_HEAD_TAGS, /rel="modulepreload"/);
});

test('SEO routes inject the generated head tags', async () => {
  for (const route of ['functions/thread/[id].ts', 'functions/arcade/[id].ts']) {
    const source = await readFile(new URL(`../${route}`, import.meta.url), 'utf8');
    assert.match(source, /SPA_HEAD_TAGS/, `${route} must import the generated head tags`);
    assert.match(source, /spaHeadTags: SPA_HEAD_TAGS/, `${route} must pass them to the SSR shell`);
  }
});
