// Docs/legal routes suppress the layout's generic OG/Twitter tags (they are in
// OWN_META_ROUTES), so their components must emit per-article share metadata.
// These checks run against the built SSR server on port 8788.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const SSR_URL = process.env.FLAXIA_SSR_URL || 'http://localhost:8788';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
const DEFAULT_OG_IMAGE = 'https://flaxia.app/og-default-v2.png';

async function getHtml(path: string): Promise<{ status: number; html: string }> {
  const response = await fetch(new URL(path, SSR_URL), { headers: { 'Accept-Language': ACCEPT_LANGUAGE } });
  return { status: response.status, html: await response.text() };
}

function metaContent(html: string, attribute: 'name' | 'property', key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`${attribute}=["']${key}["']`, 'i').test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) return content[1];
  }
  return null;
}

function canonicalHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel=["']canonical["']/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']*)["']/i);
    if (href) return href[1];
  }
  return null;
}

function titleText(html: string): string | null {
  return html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null;
}

async function assertShareTags(path: string): Promise<void> {
  const { status, html } = await getHtml(path);
  assert.equal(status, 200, `${path} must render`);

  assert.equal(html.match(/<title\b/gi)?.length ?? 0, 1, `${path} must have exactly one <title>`);
  assert.equal(html.match(/<link\b[^>]*rel=["']canonical["']/gi)?.length ?? 0, 1, `${path} must have one canonical`);
  assert.equal(
    html.match(/<meta\b[^>]*name=["']description["']/gi)?.length ?? 0,
    1,
    `${path} must have exactly one description`,
  );

  const expectedUrl = `https://flaxia.app${path}`;
  const ogUrl = metaContent(html, 'property', 'og:url');
  assert.equal(ogUrl, expectedUrl, `${path} og:url must be the canonical production URL`);
  assert.equal(canonicalHref(html), expectedUrl, `${path} canonical must be absolute`);

  const title = titleText(html);
  assert.ok(title?.trim(), `${path} must have a document title`);
  assert.equal(metaContent(html, 'property', 'og:title'), title, `${path} og:title must match the page title`);

  const description = metaContent(html, 'name', 'description');
  assert.ok(description?.trim(), `${path} must have a description`);
  assert.equal(metaContent(html, 'property', 'og:description'), description, `${path} og:description must match it`);

  const ogImage = metaContent(html, 'property', 'og:image');
  assert.ok(ogImage, `${path} must have an og:image`);
  assert.match(ogImage ?? '', /^https:\/\//, `${path} og:image must be absolute`);
  assert.equal(ogImage, DEFAULT_OG_IMAGE, `${path} must use the default share image`);

  assert.equal(metaContent(html, 'name', 'twitter:card'), 'summary_large_image');
  assert.equal(metaContent(html, 'name', 'twitter:title'), title, `${path} twitter:title must match the title`);
  assert.equal(
    metaContent(html, 'name', 'twitter:description'),
    description,
    `${path} twitter:description must match the description`,
  );
  const twitterImage = metaContent(html, 'name', 'twitter:image');
  assert.ok(twitterImage, `${path} must have a twitter:image`);
  assert.match(twitterImage ?? '', /^https:\/\//, `${path} twitter:image must be absolute`);
  assert.equal(twitterImage, ogImage, `${path} twitter:image must match og:image`);
}

test('SSR /docs has absolute Open Graph and Twitter share tags', async () => {
  await assertShareTags('/docs');
});

test('SSR /docs/<slug> has absolute Open Graph and Twitter share tags', async () => {
  const manifestResponse = await fetch(new URL('/docs/index.json', SSR_URL));
  assert.equal(manifestResponse.status, 200, 'docs manifest must be served');
  const manifest = (await manifestResponse.json()) as { docs?: Array<{ slug: string }> };
  const slug = manifest.docs?.find((doc) => doc.slug === 'whitepaper')?.slug ?? manifest.docs?.[0]?.slug;
  assert.ok(slug, 'manifest must contain at least one document');
  await assertShareTags(`/docs/${encodeURIComponent(slug)}`);
});

test('SSR legal pages have absolute Open Graph and Twitter share tags', async () => {
  for (const path of ['/about', '/privacy']) {
    await assertShareTags(path);
  }
});
