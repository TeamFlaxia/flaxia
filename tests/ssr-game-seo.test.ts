// Game posts must keep their thumbnail/playable metadata when SSR reads the
// thread endpoint. Without those columns /thread and /arcade fall back to the
// generic OGP image and lose the no-JS preview.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Post } from '../shared/types/post.ts';
import { loadThread } from '../src/lib/ssr-data.ts';
import { BASE_URL, seedUserAndLogin } from './helpers/setup.ts';

function metaContent(html: string, attribute: 'property' | 'name', key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`${attribute}=["']${key}["']`, 'i').test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) return content[1];
  }
  return null;
}

function jsonLdImage(html: string): unknown {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    if (value['@type'] === 'BlogPosting' && value.image !== undefined) return value.image;
  }
  return undefined;
}

test('thread SELECTs carry the game thumbnail and description', async () => {
  const source = await readFile(new URL('../functions/api/routes/posts/replies.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("replies.get('/posts/:id/thread'"));
  assert.ok(handler, 'the /posts/:id/thread handler must exist');
  const section = handler.split('// Step 1')[0];

  // Every SELECT on this route feeds the `root`/`replies` objects consumed by
  // the Svelte load functions, so all of them must expose the game columns.
  const selects = section.match(/SELECT[\s\S]*?FROM posts p/g) ?? [];
  assert.equal(selects.length, 2, 'the thread route should select the root post and its replies');
  for (const [index, select] of selects.entries()) {
    assert.match(select, /p\.thumbnail_key/, `thread SELECT ${index} must select p.thumbnail_key`);
    assert.match(select, /p\.game_description/, `thread SELECT ${index} must select p.game_description`);
    assert.match(select, /p\.game_title/, `thread SELECT ${index} must select p.game_title`);
  }
  const lookup = section.match(/SELECT[^`]*?FROM posts WHERE id = \?/)?.[0] ?? '';
  assert.match(lookup, /thumbnail_key/, 'the initial post lookup must select thumbnail_key');
  assert.match(lookup, /game_description/, 'the initial post lookup must select game_description');
  assert.match(lookup, /game_title/, 'the initial post lookup must select game_title');
});

test('loadThread keeps game fields on root', async () => {
  const root = {
    id: 'game-1',
    text: 'A game',
    thumbnail_key: 'thumbnail/game-1.png',
    game_description: 'Playable in the browser',
  } as unknown as Post;
  const fetchFn = (async () =>
    new Response(JSON.stringify({ root, replies: [] }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  const thread = await loadThread(fetchFn, 'game-1');
  assert.equal(thread.root?.thumbnail_key, root.thumbnail_key, 'thumbnail_key must survive the load helper');
  assert.equal(
    (thread.root as unknown as Record<string, unknown> | null)?.game_description,
    'Playable in the browser',
    'game_description must survive the load helper',
  );
});

async function seedGamePost(): Promise<{ id: string; thumbnailKey: string; text: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const { cookie } = await seedUserAndLogin(`ssrgame${suffix}`);
  const prepared = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'game.zip', contentType: 'application/zip' }),
  });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const { postId } = (await prepared.json()) as { postId: string };

  const thumbnailKey = `thumbnail/${postId}.png`;
  const text = `game seo probe ${suffix}`;
  const committed = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, zipKey: `zip/${postId}.zip`, thumbnailKey, text, hashtags: [] }),
  });
  assert.equal(committed.status, 200, await committed.clone().text());
  return { id: postId, thumbnailKey, text };
}

test('live: game thread and arcade SEO use the seeded thumbnail', async () => {
  const { id, thumbnailKey } = await seedGamePost();
  const headers = { 'Accept-Language': 'en' };

  const apiResponse = await fetch(`${BASE_URL}/api/posts/${id}/thread`, { headers });
  assert.equal(apiResponse.status, 200, 'the seeded game must be readable through the thread API');
  const threadData = (await apiResponse.json()) as { root?: Record<string, unknown> };
  assert.equal(threadData.root?.thumbnail_key, thumbnailKey, 'the thread API must return thumbnail_key');
  assert.ok(
    Object.hasOwn(threadData.root ?? {}, 'game_description'),
    'the thread API must return game_description (null is fine, an omitted column is not)',
  );

  const threadHtml = await (await fetch(`${BASE_URL}/thread/${id}`, { headers })).text();
  const threadImage = `https://flaxia.app/api/thumbnail/${encodeURIComponent(id)}`;
  assert.equal(metaContent(threadHtml, 'property', 'og:image'), threadImage, 'thread og:image must use the thumbnail');
  assert.equal(jsonLdImage(threadHtml), threadImage, 'BlogPosting image must match the thread og:image');
  assert.ok(threadHtml.includes(`/api/images/${thumbnailKey}`), 'the no-JS post card must render the game thumbnail');

  const arcadeHtml = await (await fetch(`${BASE_URL}/arcade/${id}`, { headers })).text();
  const arcadeImage = `https://flaxia.app/api/images/${encodeURIComponent(thumbnailKey)}`;
  assert.equal(metaContent(arcadeHtml, 'property', 'og:image'), arcadeImage, 'arcade og:image must use the thumbnail');
  assert.equal(jsonLdImage(arcadeHtml), arcadeImage, 'arcade BlogPosting image must match og:image');
});
