// Regression guard for docs/legal SSR. These pages used to fetch their
// markdown inside a `$effect`, so crawlers and no-JS clients only received the
// shell (nav + footer). The universal +page.ts loads must put the real article
// HTML and per-article metadata into the first response.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const SSR_URL = process.env.FLAXIA_SSR_URL || 'http://localhost:8788';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

async function getHtml(path: string): Promise<{ status: number; html: string }> {
  const response = await fetch(new URL(path, SSR_URL), { headers: { 'Accept-Language': ACCEPT_LANGUAGE } });
  return { status: response.status, html: await response.text() };
}

function countTitles(html: string): number {
  return html.match(/<title\b/gi)?.length ?? 0;
}

function metaContent(html: string, attribute: 'name' | 'property', key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`${attribute}=["']${key}["']`, 'i').test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) return content[1];
  }
  return null;
}

function canonical(html: string): string | null {
  const tag = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  return tag?.match(/href=["']([^"']+)["']/i)?.[1] ?? null;
}

function assertSeoShell(html: string, path: string, expectedCanonical: string): void {
  assert.equal(countTitles(html), 1, `${path} must have exactly one <title>`);
  assert.equal(canonical(html), expectedCanonical, `${path} must have an article canonical URL`);
  assert.ok(metaContent(html, 'name', 'description')?.trim(), `${path} must have a description`);
  assert.doesNotMatch(html, /id=["']initial-loader["']/i, `${path} must not hide article content behind a loader`);
}

test('SSR /docs lists real documents instead of an empty shell', async () => {
  const { status, html } = await getHtml('/docs');
  assert.equal(status, 200);
  assert.match(html, /class="docs-list"/);
  const slugs = [...html.matchAll(/data-docs-slug="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(slugs.length >= 3, `expected a real document list, got ${slugs.length} entries`);
  assert.ok(slugs.includes('whitepaper'), `whitepaper must be listed, got ${slugs.join(', ')}`);
  assert.match(html, /Flaxia Technical Whitepaper/);
  assert.match(html, /Joining Flaxia/);
  assertSeoShell(html, '/docs', 'https://flaxia.app/docs');
});

test('SSR /docs/<slug> contains the article body, not just navigation', async () => {
  const manifestResponse = await fetch(new URL('/docs/index.json', SSR_URL));
  assert.equal(manifestResponse.status, 200, 'docs manifest must be served');
  const manifest = (await manifestResponse.json()) as { docs?: Array<{ slug: string }> };
  const slug = manifest.docs?.find((doc) => doc.slug === 'whitepaper')?.slug ?? manifest.docs?.[0]?.slug;
  assert.ok(slug, 'manifest must contain at least one document');

  const { status, html } = await getHtml(`/docs/${encodeURIComponent(slug)}`);
  assert.equal(status, 200);
  assert.match(html, /class="legal-body docs-article-body"/);
  assert.match(html, /Executive Summary| anyone can join|Joining Flaxia/i, 'article markdown must be server rendered');
  assert.ok(html.length > 4000, 'SSR article must contain substantive body text');
  assertSeoShell(html, `/docs/${slug}`, `https://flaxia.app/docs/${encodeURIComponent(slug)}`);
});

test('SSR legal pages contain their markdown body and metadata', async () => {
  const pages = [
    { path: '/about', text: /We believe social media should be more than just a feed/ },
    { path: '/terms', text: /By creating an account, you agree to these terms/ },
    { path: '/privacy', text: /Information We Collect/ },
    { path: '/child-safety', text: /Zero-tolerance policy/ },
  ] as const;
  for (const { path, text } of pages) {
    const { status, html } = await getHtml(path);
    assert.equal(status, 200, `${path} must render`);
    assert.match(html, /class="legal-body"/, `${path} must render a legal body`);
    assert.match(html, text, `${path} must include its legal markdown text`);
    assertSeoShell(html, path, `https://flaxia.app${path}`);
  }
});

test('missing docs and legal pages return a 404 error page', async () => {
  const missing = `does-not-exist-${crypto.randomUUID().slice(0, 8)}`;
  const doc = await getHtml(`/docs/${missing}`);
  assert.equal(doc.status, 404);
  assert.match(doc.html, /404/, 'SEO error page must render for unknown docs');
});

test('docs and legal components never fetch content in an effect', async () => {
  for (const file of ['src/lib/svelte/DocsPage.svelte', 'src/lib/svelte/LegalPage.svelte']) {
    const source = await read(file);
    assert.doesNotMatch(source, /\$effect\s*\(/, `${file} must not fetch in an effect`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} must render loaded data instead of fetching`);
    assert.doesNotMatch(source, /<title\b/i, `${file} must not add a second <title>`);
    // The layout suppresses generic OG tags on these owned-meta routes, so the
    // component is the single place that may emit them.
    assert.match(
      source,
      /og:title|og:description|twitter:title|twitter:description/i,
      `${file} must emit its own share tags`,
    );
    assert.match(source, /<link rel="canonical"/, `${file} must emit its canonical URL`);
    assert.match(source, /<meta name="description"/, `${file} must emit its description`);
  }
});

test('all docs/legal routes have universal loads that use the SvelteKit fetch', async () => {
  const loads = [
    'src/routes/docs/+page.ts',
    'src/routes/docs/[slug]/+page.ts',
    'src/routes/about/+page.ts',
    'src/routes/terms/+page.ts',
    'src/routes/privacy/+page.ts',
    'src/routes/child-safety/+page.ts',
  ] as const;
  for (const file of loads) {
    const source = await read(file);
    assert.match(source, /export const load: PageLoad/, `${file} must export a universal load`);
    assert.match(source, /\bfetch\b/, `${file} must use the serialized fetch from the load event`);
    assert.doesNotMatch(source, /\bif\s*\(\s*browser\s*\)/, `${file} must not branch on browser`);
    assert.doesNotMatch(source, /window\./, `${file} must be SSR-safe`);
  }

  assert.match(await read('src/routes/docs/[slug]/+page.ts'), /error\(404/);
  const ssrContent = await read('src/lib/docs/ssr-content.ts');
  assert.match(ssrContent, /html:\s*false/, 'docs markdown must not allow raw HTML');
  assert.doesNotMatch(
    ssrContent,
    /import\s+[^;]*dompurify|dompurify\s*\.\s*sanitize/i,
    'DOMPurify needs a DOM and must stay out of SSR',
  );
});
