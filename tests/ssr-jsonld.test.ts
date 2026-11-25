// schema.org JSON-LD must survive the UA-gated SSR -> SvelteKit SSR migration.
// Every crawler-facing route used to emit ld+json; assert the new shell still
// does, and that user-controlled text cannot break out of the script element.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { BASE_URL, seedUserAndLogin } from './helpers/setup.ts';

const SSR_URL = process.env.FLAXIA_SSR_URL || BASE_URL;
const LD_SCRIPT = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

interface LdBlock {
  raw: string;
  value: Record<string, unknown>;
}

function ldBlocks(html: string): LdBlock[] {
  const blocks: LdBlock[] = [];
  for (const match of html.matchAll(LD_SCRIPT)) {
    const raw = match[1];
    // A literal closing tag inside the payload would terminate the script
    // element and let the remainder be parsed as markup (stored XSS).
    assert.ok(!raw.includes('</script'), `ld+json payload must not contain a raw </script>: ${raw.slice(0, 120)}`);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      assert.fail(`ld+json payload is not valid JSON: ${raw.slice(0, 120)} (${String(error)})`);
    }
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ld+json payload must be an object');
    blocks.push({ raw, value: value as Record<string, unknown> });
  }
  return blocks;
}

function typesOf(html: string): string[] {
  return ldBlocks(html).map((block) => String(block.value['@type']));
}

async function ssrHtml(pathname: string): Promise<string> {
  const response = await fetch(`${SSR_URL}${pathname}`);
  assert.equal(response.status, 200, `SSR ${pathname} must respond 200`);
  return response.text();
}

async function seedPost(): Promise<{ id: string; text: string; username: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const { cookie, username } = await seedUserAndLogin(suffix);
  const id = crypto.randomUUID();
  const text = `jsonld probe ${suffix}`;
  const created = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId: id, text, hashtags: [] }),
  });
  assert.equal(created.status, 200, 'seeding the probe post must succeed');
  return { id, text, username };
}

test('/home emits a valid WebSite ld+json block', async () => {
  const html = await ssrHtml('/home');
  const website = ldBlocks(html).find((block) => block.value['@type'] === 'WebSite');
  assert.ok(website, `/home must emit WebSite JSON-LD, got types: ${typesOf(html).join(', ') || 'none'}`);
  assert.equal(website.value.name, 'Flaxia');
  assert.match(String(website.value.url), /^https?:\/\//);
});

test('/arcade emits a valid CollectionPage ld+json block', async () => {
  const html = await ssrHtml('/arcade');
  const collection = ldBlocks(html).find((block) => block.value['@type'] === 'CollectionPage');
  assert.ok(collection, `/arcade must emit CollectionPage JSON-LD, got types: ${typesOf(html).join(', ') || 'none'}`);
  assert.match(String(collection.value.name), /Arcade/);
  assert.match(String(collection.value.url), /\/arcade/);
});

test('/thread/[id] emits BlogPosting ld+json containing the post text', async () => {
  const { id, text } = await seedPost();
  const html = await ssrHtml(`/thread/${id}`);
  const post = ldBlocks(html).find((block) => block.value['@type'] === 'BlogPosting');
  assert.ok(post, `/thread/${id} must emit BlogPosting JSON-LD, got types: ${typesOf(html).join(', ') || 'none'}`);
  assert.match(String(post.value.description), new RegExp(text));
  assert.match(String(post.value.url), new RegExp(`/thread/${id}`));
  assert.equal((post.value.author as Record<string, unknown> | undefined)?.['@type'], 'Person');
});

test('/users/[username] emits Person ld+json for the profile', async () => {
  const { username } = await seedPost();
  const html = await ssrHtml(`/users/${username}`);
  const person = ldBlocks(html).find((block) => block.value['@type'] === 'Person');
  assert.ok(person, `/users/${username} must emit Person JSON-LD, got types: ${typesOf(html).join(', ') || 'none'}`);
  assert.match(String(person.value.alternateName), new RegExp(username));
  assert.match(String(person.value.url), new RegExp(`/users/${username}`));
});

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(full) : Promise.resolve([full]);
    }),
  );
  return files.flat();
}

test('src emits ld+json only through the escaped renderJsonLd helper', async () => {
  const srcRoot = new URL('../src/', import.meta.url);
  const files = await sourceFiles(srcRoot.pathname);
  const sources = new Map<string, string>();
  await Promise.all(
    files.map(async (file) => {
      sources.set(path.relative(srcRoot.pathname, file), await readFile(file, 'utf8'));
    }),
  );

  const withLd = [...sources].filter(([, source]) => source.includes('application/ld+json'));
  assert.ok(withLd.length > 0, 'src must contain at least one application/ld+json occurrence');

  // Files that emit JSON-LD may only inject a helper-produced jsonLd string
  // via {@html}; a raw script element or user data in the expression would
  // let stored text break out of the <script> element.
  const ldFiles = [...sources].filter(
    ([, source]) => source.includes('application/ld+json') || /seo-jsonld/.test(source),
  );
  for (const [name, source] of ldFiles) {
    assert.doesNotMatch(
      source,
      /<script\b[^>]*application\/ld\+json/,
      `${name}: ld+json must come from the escaping helper, not a hand-written script`,
    );
    for (const match of source.matchAll(/\{@html\s+([^}]+)\}/g)) {
      const expression = match[1].trim();
      assert.match(
        expression,
        /^jsonLd\w*$/,
        `${name}: {@html} must only render a helper-produced jsonLd string, got: ${expression}`,
      );
    }
    if (name.includes('seo-jsonld')) {
      assert.match(source, /renderJsonLd\(/, 'ld+json data must be serialized by renderJsonLd');
      assert.doesNotMatch(source, /<script\b/, 'seo-jsonld must not hand-write script elements');
    }
  }
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/\{@html\s+([^}]+)\}/g)) {
      assert.doesNotMatch(match[1], /ld\+json/i, `${name}: an {@html} expression must not embed raw ld+json markup`);
    }
  }
});

test('root layout leaves the head to +error.svelte on error responses', async () => {
  const layout = await readFile(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
  assert.match(layout, /page\.status\s*>=\s*400/, 'layout must detect error responses from page.status');
  const head = layout.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? '';
  const guard = head.indexOf('{#if !isError}');
  assert.ok(guard >= 0, 'layout head must be guarded by !isError');
  for (const marker of ['<title', '{@html jsonLd}', '<meta']) {
    assert.ok(
      head.indexOf(marker) > guard,
      `layout must not emit ${marker} on error pages: +error.svelte owns title, metadata and noindex`,
    );
  }
});
