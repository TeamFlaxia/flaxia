// SSR routing/SEO guards: unknown paths must be real HTTP 404s (not a 200
// shell that redirects in onMount), `/` must redirect on the server, and the
// sitemap must not advertise a blank `/legal` page.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { BASE_URL } from './helpers/setup.ts';

const SSR_URL = process.env.FLAXIA_SSR_URL || BASE_URL;
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(new URL(`../${path}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

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

test('catch-all route throws a 404 during load instead of redirecting in onMount', async () => {
  const load = await read('src/routes/[...rest]/+page.ts');
  assert.match(load, /error\(\s*404\s*,/, 'catch-all load must throw error(404)');
  assert.doesNotMatch(load, /onMount/, 'server-side 404 must not depend on a browser redirect');

  // A leftover onMount-only page would still render the generic shell on GET.
  if (await exists('src/routes/[...rest]/+page.svelte')) {
    const page = await read('src/routes/[...rest]/+page.svelte');
    assert.doesNotMatch(
      page,
      /onMount\(\(\)\s*=>\s*\{\s*window\.location\.replace/,
      'no client-only catch-all redirect',
    );
  }
});

test('root route redirects to /home in a universal load', async () => {
  const load = await read('src/routes/+page.ts');
  assert.match(load, /redirect\(\s*308\s*,\s*['"]\/home['"]\s*\)/, 'GET / must return a 308 to /home');
  assert.doesNotMatch(load, /onMount/, 'the redirect must happen before rendering, not in the browser');
  if (await exists('src/routes/+page.svelte')) {
    const page = await read('src/routes/+page.svelte');
    assert.doesNotMatch(page, /window\.location\.replace/, 'no client-only root redirect');
  }
});

test('sitemap does not advertise a blank /legal page and _redirects sends it to /privacy', async () => {
  const sitemap = await read('functions/sitemap.xml.ts');
  assert.doesNotMatch(sitemap, /\$\{baseUrl\}\/legal\b/, 'sitemap must not list the non-existent /legal page');
  assert.match(sitemap, /\/privacy\b/, 'sitemap should advertise the real privacy page instead');

  const redirects = await read('_redirects');
  assert.match(redirects, /\/legal\s+\/privacy\s+308/, '/legal should permanently redirect to /privacy');
});

test('SSR unknown paths respond 404 with exactly one noindex title', async () => {
  const response = await fetch(`${SSR_URL}/definitely-not-a-route-${crypto.randomUUID().slice(0, 8)}`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 404, 'unknown paths must be hard 404s');
  const html = await response.text();
  assert.equal(countTitles(html), 1, 'the 404 document must have exactly one <title>');
  assert.match(metaContent(html, 'robots') ?? '', /noindex/i, '404 must not be indexed');
});

test('SSR GET / redirects to /home without rendering a client-only shell', async () => {
  const response = await fetch(`${SSR_URL}/`, { redirect: 'manual' });
  assert.ok(response.status === 301 || response.status === 308, 'GET / must be a permanent redirect');
  assert.equal(new URL(response.headers.get('location') ?? '', SSR_URL).pathname, '/home');
});

test('GET /legal resolves to a real page (not a generic 200)', async () => {
  const response = await fetch(`${SSR_URL}/legal`, { redirect: 'manual' });
  assert.ok(
    response.status === 308 || response.status === 404,
    `/legal must redirect to /privacy or 404, got ${response.status}`,
  );
  if (response.status === 308) {
    assert.equal(new URL(response.headers.get('location') ?? '', SSR_URL).pathname, '/privacy');
  }
});
