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
