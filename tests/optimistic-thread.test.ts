// Clicking a post should show its root in the same frame while the full thread
// loads. The cache contract is exercised directly; the routing/UI contract is
// source-inspected so it stays testable without a browser or SvelteKit runtime.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Post } from '../shared/types/post.ts';
import {
  clearOptimisticRoots,
  OPTIMISTIC_ROOT_LIMIT,
  OPTIMISTIC_ROOT_TTL_MS,
  rememberPost,
  takeOptimisticRoot,
} from '../src/lib/thread/optimistic-thread.ts';

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function postStub(id: string): Post {
  return { id, text: `text-${id}`, reply_count: 0 } as unknown as Post;
}

// --- cache behaviour --------------------------------------------------------

test('optimistic root cache returns a snapshot exactly once', () => {
  clearOptimisticRoots();
  const post = postStub('once');
  rememberPost(post, 1_000);
  post.text = 'mutated after caching';
  const taken = takeOptimisticRoot('once', 1_000);
  assert.equal(taken?.id, 'once');
  assert.equal(taken?.text, 'text-once', 'the cached snapshot must not track later prop mutations');
  assert.equal(takeOptimisticRoot('once', 1_000), null, 'one-shot consumption');
});

test('optimistic root cache is bounded', () => {
  clearOptimisticRoots();
  const ids = Array.from({ length: OPTIMISTIC_ROOT_LIMIT + 5 }, (_, i) => `p${i}`);
  ids.forEach((id, i) => {
    rememberPost(postStub(id), 2_000 + i);
  });
  assert.equal(takeOptimisticRoot(ids[0], 9_000), null, 'oldest entries are evicted');
  assert.equal(takeOptimisticRoot(ids[ids.length - 1], 9_000)?.id, ids[ids.length - 1]);
});

test('optimistic root cache expires entries after its TTL', () => {
  clearOptimisticRoots();
  rememberPost(postStub('fresh'), 1_000);
  assert.equal(takeOptimisticRoot('fresh', 1_000 + OPTIMISTIC_ROOT_TTL_MS)?.id, 'fresh');
  rememberPost(postStub('stale'), 1_000);
  assert.equal(takeOptimisticRoot('stale', 1_000 + OPTIMISTIC_ROOT_TTL_MS + 1), null);
});

test('cache module is runtime-agnostic and importable outside SvelteKit', async () => {
  const source = await read('src/lib/thread/optimistic-thread.ts');
  assert.doesNotMatch(source, /\$app\//);
  assert.match(source, /export function rememberPost/);
  assert.match(source, /export function takeOptimisticRoot/);
});

// --- PostCard ---------------------------------------------------------------

test('PostCard caches the clicked post before navigating to its thread', async () => {
  const source = await read('src/lib/svelte/PostCard.svelte');
  const click = source.slice(source.indexOf('function onPostClick'), source.indexOf('function handleReplyCreated'));
  assert.match(click, /if \(props\.disableNavigation\) return/, 'existing navigation guard stays');
  const rememberAt = click.indexOf('rememberPost(');
  const navigateAt = click.indexOf('navigate(`/thread/');
  assert.ok(rememberAt !== -1, 'onPostClick must snapshot the post');
  assert.ok(navigateAt !== -1, 'onPostClick must still navigate');
  assert.ok(rememberAt < navigateAt, 'snapshot must be cached before goto() runs');
});

test('PostCard prefetches thread data/code on hover and focus', async () => {
  const source = await read('src/lib/svelte/PostCard.svelte');
  assert.match(source, /onpointerenter=\{[^\n]*prefetchThread\(/);
  assert.match(source, /onfocus=\{[^\n]*prefetchThread\(/);
  assert.match(source, /onpointerenter=\{[^\n]*if \(!props\.disableNavigation\)[^\n]*prefetchThread\(/);
  assert.match(source, /onfocus=\{[^\n]*if \(!props\.disableNavigation\)[^\n]*prefetchThread\(/);
});

// --- navigation + ambient types --------------------------------------------

test('navigation.ts prefetches with Kit 3 APIs, deduped, respecting data saver', async () => {
  const source = await read('src/lib/navigation.ts');
  assert.match(source, /preloadData/);
  assert.match(source, /preloadCode/);
  assert.doesNotMatch(source, /invalidate\(/, 'invalidate destroys the preload cache');
  assert.match(source, /export function prefetchThread/);
  const body = source.slice(source.indexOf('export function prefetchThread'));
  assert.match(body, /isDataSaverEnabled\(\)/);
  assert.match(body, /preloadData\(href\)/);
  assert.match(body, /preloadCode\(/);
  assert.match(source, /PREFETCH_DELAY_MS\s*=\s*100/, 'hover intent delay');
});

test('ambient navigation types declare the Kit 3 preload helpers', async () => {
  const source = await read('src/types/app-navigation.d.ts');
  assert.match(source, /export function preloadData\(/);
  assert.match(source, /export function preloadCode\(/);
});

// --- route load -------------------------------------------------------------

test('thread route defers the await only in the browser with a cached root', async () => {
  const source = await read('src/routes/thread/[id]/+page.ts');
  assert.match(source, /import\.meta\.env\.BUILD_TARGET === 'native'/);
  assert.match(source, /setHeaders\(/, 'keep private cache headers');
  assert.match(source, /error\(404/, 'keep 404 handling');

  const branchAt = source.indexOf('if (!import.meta.env.SSR)');
  const takeAt = source.indexOf('takeOptimisticRoot(params.id)');
  const fetchAt = source.indexOf('await loadThread(');
  assert.ok(branchAt !== -1, 'browser-only branch must not run during SSR');
  assert.ok(takeAt > branchAt && takeAt < fetchAt, 'cache lookup must precede the blocking load');
  const branch = source.slice(branchAt, fetchAt);
  assert.doesNotMatch(branch, /await loadThread/, 'deferred branch must be non-blocking');
  assert.match(branch, /deferred:\s*true/);
});

// --- page + interactive view ------------------------------------------------

test('thread page forwards the deferred flag and keeps key/SEO markup', async () => {
  const source = await read('src/routes/thread/[id]/+page.svelte');
  assert.match(source, /initialRoot=\{data\.root\}/);
  assert.match(source, /initialReplies=\{data\.replies\}/);
  assert.match(source, /deferred=\{data\.deferred\}/);
  assert.match(source, /\{#key page\.params\.id\}/);
  assert.match(source, /<title>\{metaTitle\}<\/title>/);
});

test('ThreadPage mounts the cached root in onMount without awaiting', async () => {
  const source = await read('src/lib/svelte/ThreadPage.svelte');
  const mount = source.slice(source.indexOf('function mountRoot'), source.indexOf('async function loadThread'));
  assert.match(mount, /mountThreadPostCard\(/);

  const onMountBody = source.slice(source.indexOf('onMount('), source.indexOf('onDestroy('));
  assert.match(onMountBody, /if \(initialRoot\)/);
  assert.match(onMountBody, /mountRoot\(initialRoot/);
  assert.doesNotMatch(onMountBody, /\bawait\b/, 'onMount must mount in the same frame, before any await');
});

test('ThreadPage reconciles the mounted root via update() and shows reply skeletons', async () => {
  const source = await read('src/lib/svelte/ThreadPage.svelte');
  const load = source.slice(source.indexOf('async function loadThread'), source.indexOf('onMount('));
  assert.match(load, /deferred/, 'loadThread must know when replies were deferred');
  assert.match(load, /rootCard\?\.update\(|rootCard\.update\(/, 'reconcile in place, never remount');
  assert.doesNotMatch(load, /mountThreadPostCard\(/, 'remounting would restart game iframes');

  assert.match(source, /thread-reply-skeleton/);
  assert.match(source, /#if loading && deferred[\s\S]{0,240}thread-reply-skeleton/);
});
