// Per-route SSR metadata: one <title> per document, and page-specific OG tags.
// The SvelteKit shell owns the title; static app.html tags would duplicate it
// and pin every social card to the generic "Flaxia" copy.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { BASE_URL, seedUserAndLogin } from './helpers/setup.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function countTitles(html: string): number {
  return html.match(/<title\b/gi)?.length ?? 0;
}

function metaContent(html: string, attribute: 'property' | 'name', key: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!new RegExp(`${attribute}=["']${key}["']`, 'i').test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) return content[1];
  }
  return null;
}

test('app.html leaves all title and social metadata to SvelteKit', async () => {
  const html = await read('src/app.html');
  assert.doesNotMatch(html, /<title\b/i, 'static app.html must not hard-code a <title>');
  assert.doesNotMatch(html, /og:title/i, 'static app.html must not hard-code og:title');
  assert.match(html, /%sveltekit\.head%/, 'the SvelteKit head placeholder must stay');
  assert.match(html, /name="viewport"/, 'viewport stays in the static shell');
  assert.match(html, /name="theme-color"/, 'theme-color stays in the static shell');
});

test('SSR pages emit one title and route-specific Open Graph metadata', async () => {
  // Seed our own account/post: other SSR suites reset the DB in beforeEach.
  const suffix = crypto.randomUUID().slice(0, 8);
  const { cookie, username } = await seedUserAndLogin(`ssrmeta${suffix}`);
  const postId = crypto.randomUUID();
  const text = `hydration probe hydmwvcvab2 ${suffix}`;
  const created = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, text, hashtags: [] }),
  });
  assert.equal(created.status, 200, 'seeding the probe post must succeed');

  const homeHtml = await (await fetch(`${BASE_URL}/home`)).text();
  assert.equal(countTitles(homeHtml), 1, '/home must have exactly one <title>');
  assert.equal(metaContent(homeHtml, 'property', 'og:title'), 'Flaxia');

  const threadHtml = await (await fetch(`${BASE_URL}/thread/${postId}`)).text();
  assert.equal(countTitles(threadHtml), 1, '/thread/[id] must have exactly one <title>');
  const ogTitle = metaContent(threadHtml, 'property', 'og:title');
  const ogDescription = metaContent(threadHtml, 'property', 'og:description');
  assert.ok(ogTitle?.includes(text), `thread og:title must contain the post text, got: ${ogTitle}`);
  assert.ok(ogDescription?.includes(text), `thread og:description must contain the post text, got: ${ogDescription}`);
  const threadCanonical = threadHtml.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  assert.match(threadCanonical ?? '', new RegExp(`/thread/${postId}`), 'thread canonical URL must point at the post');

  const profileHtml = await (await fetch(`${BASE_URL}/users/${username}`)).text();
  assert.equal(countTitles(profileHtml), 1, '/users/[username] must have exactly one <title>');
  const profileOgTitle = metaContent(profileHtml, 'property', 'og:title');
  assert.ok(profileOgTitle?.includes(username), `profile og:title must name the user, got: ${profileOgTitle}`);
  assert.ok(metaContent(profileHtml, 'property', 'og:description'), 'profile must have an og:description');
});

function canonicalHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel=["']canonical["']/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']*)["']/i);
    if (href) return href[1];
  }
  return null;
}

test('layout emits one path-only canonical, matching og:url, and one guarded title', async () => {
  const layout = await read('src/routes/+layout.svelte');
  assert.match(
    layout,
    /<link\s+rel="canonical"\s+href=\{canonicalUrl\}\s*\/>/,
    'generic routes must emit a canonical link',
  );
  assert.match(
    layout,
    /https:\/\/flaxia\.app\$\{page\.url\.pathname\}/,
    'canonical/og:url must be path-only on the production origin',
  );
  assert.match(layout, /property="og:url"\s+content=\{canonicalUrl\}/, 'og:url must reuse the canonical URL');
  assert.doesNotMatch(
    layout,
    /property="og:url"\s+content=\{page\.url\.href\}/,
    'og:url must not include query strings or the dev origin',
  );

  const head = layout.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? '';
  assert.equal((head.match(/<title\b/gi) ?? []).length, 1, 'layout must contain exactly one <title>');
  assert.match(
    head,
    /\{#if\s+!hasSelfTitle\}[\s\S]*?<title>/,
    'the layout title must be suppressed on OWN_META routes',
  );

  // The generic description is localized through the request-scoped resolver.
  assert.match(layout, /\bt\(['"]site\.description['"]\)/, 'static description must be localized via t()');
  assert.doesNotMatch(
    head,
    /content=["']The SNS where your posts are playable\./,
    'no hard-coded description in the head',
  );
});

test('per-route metadata routes own their title and /download suppresses generic meta', async () => {
  const layout = await read('src/routes/+layout.svelte');
  assert.match(
    layout,
    /OWN_META_ROUTES[\s\S]*?['"]\/download['"]/,
    '/download must be in OWN_META_ROUTES so its own head is not duplicated',
  );
  for (const path of [
    'src/routes/thread/[id]/+page.svelte',
    'src/routes/users/[username]/+page.svelte',
    'src/routes/arcade/+page.svelte',
    'src/routes/arcade/[id]/+page.svelte',
  ]) {
    const source = await read(path);
    assert.match(source, /<title>/, `${path} must emit its own <title>`);
  }
});

test('authenticated routes are noindex in the layout, error pages keep their own', async () => {
  const layout = await read('src/routes/+layout.svelte');
  for (const route of ['/settings', '/mail', '/notifications', '/bookmarks', '/admin']) {
    assert.match(layout, new RegExp(`['"]${route.replace('/', '\\/')}['"]`), `${route} must be listed as private`);
  }
  const head = layout.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? '';
  assert.match(head, /name="robots"\s+content="noindex, nofollow"/, 'private routes must carry noindex, nofollow');
  assert.match(
    head,
    /\{#if\s+page\.status\s*<\s*400\}/,
    'error pages must not receive a second robots tag from the layout',
  );
});

test('docs/legal routes take their single title from load data', async () => {
  const layout = await read('src/routes/+layout.svelte');
  const ids = ['/docs', '/docs/[slug]', '/about', '/terms', '/privacy', '/child-safety'];
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
    assert.match(
      layout,
      new RegExp(`OWN_META_ROUTES[\\s\\S]*?['"]${escaped}['"]`),
      `${id} must be in OWN_META_ROUTES (its component owns canonical/description)`,
    );
    assert.match(
      layout,
      new RegExp(`OWN_TITLE_ROUTES[\\s\\S]*?['"]${escaped}['"]`),
      `${id} must be in OWN_TITLE_ROUTES (its load owns the title)`,
    );
  }
  assert.match(layout, /page\.data\??\.title/, 'the layout title must prefer page.data.title');
  const head = layout.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? '';
  assert.equal((head.match(/<title\b/gi) ?? []).length, 1, 'layout must keep exactly one <title>');
});

test('layout reads page.status only in the render path', async () => {
  const layout = await read('src/routes/+layout.svelte');
  const script = layout.match(/<script[\s\S]*?<\/script>/)?.[0] ?? '';
  assert.doesNotMatch(
    script,
    /page\.status/,
    'a module-level page.status read throws state_read_outside_render in dev',
  );
  const head = layout.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? '';
  assert.match(head, /\{#if\s+page\.status\s*<\s*400\}/, 'the error guard must live in the head template');
});

test('SSR docs/legal pages have one title, canonical and description', async () => {
  for (const path of ['/docs', '/about', '/privacy', '/terms', '/child-safety']) {
    const html = await (await fetch(`${BASE_URL}${path}`)).text();
    assert.equal(countTitles(html), 1, `${path} must have exactly one <title>`);
    const canonicals = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi) ?? [];
    assert.equal(canonicals.length, 1, `${path} must have exactly one canonical link`);
    const descriptions = html.match(/<meta\b[^>]*name=["']description["'][^>]*>/gi) ?? [];
    assert.equal(descriptions.length, 1, `${path} must have exactly one description`);
  }
});

test('SSR generic routes carry a canonical and path-only og:url', async () => {
  const home = await (await fetch(`${BASE_URL}/home`)).text();
  assert.equal(countTitles(home), 1);
  assert.equal(canonicalHref(home), 'https://flaxia.app/home');
  assert.equal(metaContent(home, 'property', 'og:url'), 'https://flaxia.app/home');

  const search = await (await fetch(`${BASE_URL}/search?q=cats&type=users`)).text();
  assert.equal(canonicalHref(search), 'https://flaxia.app/search', 'canonical must drop the query string');
  assert.equal(
    metaContent(search, 'property', 'og:url'),
    'https://flaxia.app/search',
    'og:url must drop the query string',
  );
});

test('SSR /download has exactly one description and an absolute og:url', async () => {
  const html = await (await fetch(`${BASE_URL}/download`)).text();
  const descriptions = html.match(/<meta\b[^>]*name=["']description["'][^>]*>/gi) ?? [];
  assert.equal(descriptions.length, 1, '/download must not emit a duplicate description');
  const ogUrl = metaContent(html, 'property', 'og:url') ?? '';
  assert.match(ogUrl, /^https:\/\//, 'og:url must be absolute');
});

test('SSR authenticated routes are not indexable', async () => {
  for (const path of ['/settings', '/mail', '/notifications', '/bookmarks', '/admin']) {
    const html = await (await fetch(`${BASE_URL}${path}`)).text();
    assert.match(metaContent(html, 'name', 'robots') ?? '', /noindex/i, `${path} must not be indexed`);
  }
});
