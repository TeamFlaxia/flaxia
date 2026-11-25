// SSR load helpers must distinguish "not found" from "upstream failed":
// collapsing a 5xx into an empty result turns outages into bogus 404 pages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFeed, loadGames, loadProfile, loadThread, loadUserFeed } from '../src/lib/ssr-data.ts';

const jsonFetch =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as Response;

test('a 404 from the API stays a normal not-found result', async () => {
  assert.deepEqual(await loadThread(jsonFetch(404, {}), 'missing'), { root: null, replies: [] });
  assert.deepEqual(await loadProfile(jsonFetch(404, {}), 'missing'), { user: null });
  assert.deepEqual(await loadFeed(jsonFetch(404, {})), { posts: [], nextCursor: undefined });
  assert.deepEqual(await loadUserFeed(jsonFetch(404, {}), 'missing'), { posts: [], nextCursor: undefined });
  assert.deepEqual(await loadGames(jsonFetch(404, {})), []);
});

test('a 5xx from the API is surfaced instead of being reported as not found', async () => {
  await assert.rejects(loadThread(jsonFetch(503, {}), 'x'), /503/);
  await assert.rejects(loadProfile(jsonFetch(500, {}), 'x'), /500/);
  await assert.rejects(loadFeed(jsonFetch(502, {})), /502/);
  await assert.rejects(loadGames(jsonFetch(500, {})), /500/);
});

test('a network failure is surfaced', async () => {
  const failing = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  await assert.rejects(
    loadThread(failing, 'x'),
    (error: Error & { cause?: Error }) => error.cause?.message === 'network down',
  );
});

test('successful payloads keep their existing shapes', async () => {
  const post = { id: 'p1', text: 'hello' };
  assert.deepEqual(await loadThread(jsonFetch(200, { root: post, replies: [] }), 'p1'), {
    root: post,
    replies: [],
  });
  assert.deepEqual(await loadProfile(jsonFetch(200, { user: { username: 'alice' } }), 'alice'), {
    user: { username: 'alice' },
  });
  assert.deepEqual(await loadFeed(jsonFetch(200, { posts: [post], next_cursor: 'abc' })), {
    posts: [post],
    nextCursor: 'abc',
  });
});
