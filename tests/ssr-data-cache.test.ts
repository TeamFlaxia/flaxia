// Universal loads re-run on client navigation. Without a short-lived client
// cache every click to a data route repeats the same API round trip even when
// the data was already serialized during SSR/hydration.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('client-side SSR data loads reuse a fresh response and can be invalidated', async () => {
  const previous = globalThis.window;
  // biome-ignore lint/suspicious/noExplicitAny: minimal window stub for a Node test
  (globalThis as any).window = { addEventListener: () => {} };
  try {
    const { loadFeed, clearSsrDataCache } = await import('../src/lib/ssr-data.ts');
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ posts: [], next_cursor: null }), { status: 200 });
    };

    await loadFeed(fakeFetch as unknown as typeof fetch, 20);
    await loadFeed(fakeFetch as unknown as typeof fetch, 20);
    assert.equal(calls, 1, 'a repeated universal load must reuse the cached data');

    clearSsrDataCache();
    await loadFeed(fakeFetch as unknown as typeof fetch, 20);
    assert.equal(calls, 2, 'clearing the cache must force a fresh fetch');
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});
