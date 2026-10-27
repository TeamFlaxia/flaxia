import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { afterEach, test } from 'node:test';
import type { Game } from '../src/types/game.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.')
      ) {
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      }
      throw error;
    }
  },
});
const { findAvailableArcadeGame, isArcadeGameAvailable } = await import('../src/lib/arcade-availability.ts');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function game(id: string): Game {
  return {
    id,
    postId: id,
    title: id,
    username: 'author',
    type: 'zip',
    payloadKey: `zip/${id}.zip`,
    freshCount: 0,
    replyCount: 0,
    bookmarkCount: 0,
    impressions: 0,
    createdAt: new Date().toISOString(),
  };
}

test('checks the actual sandbox entry URL with HEAD before selecting a game', async () => {
  const items = [game('missing'), game('gone'), game('playable')];
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(init?.method, 'HEAD');
    assert.equal(init?.cache, 'no-store');
    return new Response(null, {
      status: String(url).includes('/missing?') ? 404 : String(url).includes('/gone?') ? 410 : 200,
    });
  };
  const missing: string[] = [];
  const selection = await findAvailableArcadeGame(items, 0, {
    isAvailable: (item) => isArcadeGameAvailable(item, 'https://sandbox.flaxia.app'),
    loadMore: async () => false,
    onMissing: (item) => missing.push(item.id),
    signal: new AbortController().signal,
  });
  assert.equal(selection?.game.id, 'playable');
  assert.equal(selection?.index, 0);
  assert.deepEqual(
    items.map((item) => item.id),
    ['playable'],
  );
  assert.deepEqual(missing, ['missing', 'gone']);
  assert.deepEqual(
    requests,
    ['missing', 'gone', 'playable'].map((id) => `https://sandbox.flaxia.app/api/wvfs-zip/${id}?runtime=2`),
  );
});

test('keeps paging across empty or missing pages to find an available game', async () => {
  const items = [game('missing')];
  let pages = 0;
  const selection = await findAvailableArcadeGame(items, 0, {
    isAvailable: async (item) => item.id === 'playable',
    loadMore: async () => {
      pages++;
      if (pages === 2) items.push(game('also-missing'));
      if (pages === 3) items.push(game('playable'));
      return pages <= 3;
    },
    onMissing: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(selection?.game.id, 'playable');
  assert.equal(pages, 3);
});

test('returns an empty result when every game is missing', async () => {
  const items = [game('one'), game('two')];
  const selection = await findAvailableArcadeGame(items, 0, {
    isAvailable: async () => false,
    loadMore: async () => false,
    onMissing: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(selection, null);
  assert.deepEqual(items, []);
});

test('falls back to the previous available game if the last game has disappeared', async () => {
  const items = [game('previous'), game('missing')];
  const selection = await findAvailableArcadeGame(items, 1, {
    isAvailable: async (item) => item.id === 'previous',
    loadMore: async () => false,
    onMissing: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(selection?.index, 0);
  assert.equal(selection?.game.id, 'previous');
});

test('server and network failures do not remove games as though they were missing', async () => {
  for (const status of [200, 403, 405, 429, 500, 503]) {
    globalThis.fetch = async () => new Response(null, { status });
    assert.equal(await isArcadeGameAvailable(game('retryable'), 'https://sandbox.flaxia.app'), true);
  }
  globalThis.fetch = async () => {
    throw new TypeError('Network unavailable');
  };
  assert.equal(await isArcadeGameAvailable(game('retryable'), 'https://sandbox.flaxia.app'), true);
});

test('checks the HTML5 playback route as well', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/games/html5/html-game');
    assert.equal(init?.method, 'HEAD');
    return new Response(null, { status: 404 });
  };
  assert.equal(
    await isArcadeGameAvailable({ ...game('html-game'), type: 'html5' }, 'https://sandbox.flaxia.app'),
    false,
  );
});

test('cancelled selection never removes a game or renders a stale result', async () => {
  const items = [game('one')];
  const controller = new AbortController();
  let resolveCheck: (available: boolean) => void = () => {};
  const selected = findAvailableArcadeGame(items, 0, {
    isAvailable: () =>
      new Promise<boolean>((resolve) => {
        resolveCheck = resolve;
      }),
    loadMore: async () => false,
    onMissing: () => {
      assert.fail('cancelled selection must not mutate the queue');
    },
    signal: controller.signal,
  });
  controller.abort();
  resolveCheck(false);
  await assert.rejects(selected, { name: 'AbortError' });
  assert.equal(items.length, 1);
});

const { ArcadeAvailabilityPrefetch } = await import('../src/lib/arcade-availability-prefetch.ts');

test('preflights the next game and reuses its HEAD response on navigation', async () => {
  let checked = 0;
  globalThis.fetch = async () => {
    checked++;
    return new Response(null, { status: 200 });
  };

  const prefetch = new ArcadeAvailabilityPrefetch('https://sandbox.flaxia.app');
  const next = game('next');
  await prefetch.prefetch(next);
  assert.equal(await prefetch.isAvailable(next, new AbortController().signal), true);
  assert.equal(checked, 1, 'do not issue a second serialized HEAD on swipe');
  prefetch.destroy();
});

test('aborting an old selection does not cancel or poison the prefetched next game', async () => {
  let release: (response: Response) => void = () => {};
  let checked = 0;
  globalThis.fetch = async () => {
    checked++;
    return new Promise<Response>((resolve) => { release = resolve; });
  };
  const prefetch = new ArcadeAvailabilityPrefetch('https://sandbox.flaxia.app');
  const next = game('next');
  const firstRender = new AbortController();
  const oldSelection = prefetch.isAvailable(next, firstRender.signal);
  firstRender.abort();
  await assert.rejects(oldSelection, { name: 'AbortError' });

  const nextRender = prefetch.isAvailable(next, new AbortController().signal);
  release(new Response(null, { status: 200 }));
  assert.equal(await nextRender, true);
  assert.equal(checked, 1);
  prefetch.destroy();
});

test('a prefetched missing game is still omitted by the normal Arcade selection logic', async () => {
  globalThis.fetch = async (url) => new Response(null, {
    status: String(url).includes('/missing?') ? 404 : 200,
  });
  const prefetch = new ArcadeAvailabilityPrefetch('https://sandbox.flaxia.app');
  const games = [game('missing'), game('available')];
  await Promise.all(games.map((item) => prefetch.prefetch(item)));
  const missing: string[] = [];
  const controller = new AbortController();
  const selection = await findAvailableArcadeGame(games, 0, {
    isAvailable: (item) => prefetch.isAvailable(item, controller.signal),
    loadMore: async () => false,
    onMissing: (item) => missing.push(item.id),
    signal: controller.signal,
  });
  assert.equal(selection?.game.id, 'available');
  assert.deepEqual(missing, ['missing']);
  prefetch.destroy();
});
