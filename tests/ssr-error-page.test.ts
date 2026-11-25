// SSR error pages must still carry usable SEO metadata for crawlers and
// no-JS visitors. SvelteKit's built-in error page has no robots/description,
// which regressed from the old crawler "Not Found" shell.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const SSR_URL = process.env.FLAXIA_SSR_URL || 'http://localhost:8788';
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function countTitles(html: string): number {
  return html.match(/<title\b/gi)?.length ?? 0;
}

function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`name=["']${key}["']`, 'i').test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) return content[1];
  }
  return null;
}

test('+error.svelte emits SEO-safe head metadata', async () => {
  const source = await read('src/routes/+error.svelte');
  assert.match(source, /<svelte:head>/, 'the error page must set head tags');
  assert.match(source, /<title>/, 'the error page must set a title');
  assert.match(source, /name="robots"\s+content="noindex/i, 'errors must not be indexed');
  assert.match(source, /<meta\s+name="description"/, 'the error page needs a description');
  assert.match(source, /<link\s+rel="canonical"/, 'the error page needs a canonical URL (derived from page.url)');
  assert.match(source, /import\s+\{\s*page\s*\}\s+from\s+'\$app\/state'/, 'use the reactive page state');
});

test('SSR 404 responses are readable and noindex', async () => {
  const response = await fetch(`${SSR_URL}/thread/${crypto.randomUUID()}`);
  assert.equal(response.status, 404, 'an unknown thread must be a 404');
  const html = await response.text();

  assert.equal(countTitles(html), 1, 'the error document must have exactly one <title>');
  assert.match(metaContent(html, 'robots') ?? '', /noindex/i, 'error pages must carry noindex robots');
  assert.ok(metaContent(html, 'description'), 'error pages must carry a description');

  const visibleText = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  assert.match(visibleText, /404|not found/i, 'the error page must explain the failure to humans');
});
