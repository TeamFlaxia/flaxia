import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createOfflineGameStore, type DownloadedGame } from '../src/lib/offline-game-store.ts';
import { createOfflineGames } from '../src/lib/offline-games.ts';
import type { Post } from '../src/types/post.ts';

const post = (id = 'game1'): Post => ({
  id,
  user_id: 'author',
  username: 'author',
  text: 'A game',
  hashtags: '[]',
  payload_key: `zip/${id}.zip`,
  created_at: '2026-10-24T00:00:00Z',
  fresh_count: 0,
  reload_count: 0,
  bookmark_count: 1,
  reply_count: 0,
  impressions: 0,
  depth: 0,
  hidden: 0,
  status: 'published',
  is_bookmarked: true,
});
const files = () => [{ path: 'index.html', bytes: new TextEncoder().encode('<h1>game</h1>').buffer }];
function fixture(factory = new IDBFactory()) {
  let online = true,
    time = Date.now(),
    revision = 'a'.repeat(64),
    status = 200;
  let bookmarks = [post()];
  let extractionFails = false;
  const requests: string[] = [];
  const network: typeof fetch = async (input) => {
    if (!online) throw new TypeError('offline');
    const url = new URL((input as Request).url);
    requests.push(url.pathname);
    if (url.pathname === '/api/bookmarks') return Response.json({ posts: bookmarks });
    if (url.pathname.startsWith('/api/posts/')) return Response.json({ post: post(url.pathname.split('/').at(-1)) });
    if (url.pathname.endsWith('/archive')) return new Response('ZIP');
    if (status !== 200) return new Response(null, { status });
    const id = url.pathname.split('/').at(-1);
    return Response.json({
      postId: id,
      revision,
      cacheable: true,
      archiveUrl: `https://flaxia.app/api/game-loader/${id}/archive?revision=${revision}`,
    });
  };
  const make = () =>
    createOfflineGames({
      store: createOfflineGameStore(factory),
      network,
      online: () => online,
      now: () => time,
      extract: async () => {
        if (extractionFails) throw new Error('corrupt ZIP');
        return files();
      },
    });
  return {
    make,
    requests,
    setOnline: (value: boolean) => {
      online = value;
    },
    setStatus: (value: number) => {
      status = value;
    },
    setRevision: (value: string) => {
      revision = value;
    },
    setBookmarks: (value: Post[]) => {
      bookmarks = value;
    },
    failExtraction: () => {
      extractionFails = true;
    },
    advance: (value: number) => {
      time += value;
    },
  };
}

test('bookmarked games survive a cold start and are available without any network', async () => {
  const f = fixture();
  const first = f.make();
  await first.account('alice');
  await first.sync();
  assert.equal(first.states.get('game1'), 'saved');
  f.setOnline(false);
  const restarted = f.make();
  await restarted.account('alice');
  assert.equal((await restarted.files('game1'))?.[0].path, 'index.html');
  const fetch = restarted.wrap(async () => {
    throw new TypeError('offline');
  });
  const bookmarks = await fetch('/api/bookmarks?limit=10');
  assert.equal(bookmarks.headers.get('X-Flaxia-Offline'), '1');
  assert.equal((await bookmarks.json()).posts[0].id, 'game1');
  assert.equal((await (await fetch('/api/games?initialId=game1')).json()).games[0].postId, 'game1');
  assert.equal(await restarted.files('game1', 'different-version'), undefined);
});

test('a successful bookmark toggle starts a download; removing it deletes the saved game', async () => {
  const f = fixture();
  const games = f.make();
  await games.account('alice');
  await games.download(post());
  const fetch = games.wrap(async () => Response.json({ bookmarked: false }));
  await fetch('/api/posts/game1/bookmark', { method: 'POST' });
  assert.equal((await games.list()).length, 0);
  await games.download(post());
  assert.equal((await games.list()).length, 0);
});

test('logout, 401 and account changes remove all downloaded files', async () => {
  for (const action of ['logout', '401', 'switch']) {
    const f = fixture();
    const games = f.make();
    await games.account('alice');
    await games.download(post());
    if (action === 'switch') await games.account('bob');
    else {
      const fetch = games.wrap(async () => new Response(null, { status: action === '401' ? 401 : 200 }));
      await fetch(action === '401' ? '/api/me' : '/api/auth/logout', { method: action === '401' ? 'GET' : 'POST' });
    }
    await games.account('alice');
    assert.equal((await games.list()).length, 0, action);
  }
});

test('online playback revalidates publication, refreshes revisions and honors revocation', async () => {
  const f = fixture();
  const games = f.make();
  await games.account('alice');
  await games.download(post());
  f.setRevision('b'.repeat(64));
  await games.files('game1');
  assert.equal((await games.list())[0].revision, 'b'.repeat(64));
  f.setStatus(404);
  assert.equal(await games.files('game1'), undefined);
  f.setOnline(false);
  assert.equal(await games.files('game1'), undefined);
});

test('failed extraction never commits a partial game and expiry prevents offline playback', async () => {
  const f = fixture();
  const games = f.make();
  await games.account('alice');
  await games.download(post());
  f.advance(7 * 24 * 60 * 60 * 1000 + 1);
  f.setOnline(false);
  assert.equal(await games.files('game1'), undefined);
  f.setOnline(true);
  f.failExtraction();
  f.setRevision('c'.repeat(64));
  await games.download(post());
  assert.equal(games.states.get('game1'), 'error');
  assert.equal((await games.list()).length, 0);
});

test('full bookmark reconciliation removes downloads no longer bookmarked', async () => {
  const f = fixture();
  const games = f.make();
  await games.account('alice');
  await games.sync();
  f.setBookmarks([]);
  await games.sync();
  assert.equal((await games.list()).length, 0);
});

test('a download finishing after logout or unbookmark cannot resurrect files', async () => {
  for (const logout of [true, false]) {
    let release!: () => void;
    let started!: () => void;
    const extracting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const games = createOfflineGames({
      store: createOfflineGameStore(new IDBFactory()),
      online: () => true,
      network: async (input) => {
        const url = new URL((input as Request).url);
        return url.pathname.endsWith('/archive')
          ? new Response('zip')
          : Response.json({
              postId: 'game1',
              revision: 'a'.repeat(64),
              cacheable: true,
              archiveUrl: 'https://flaxia.app/api/game-loader/game1/archive',
            });
      },
      extract: async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return files();
      },
    });
    await games.account('alice');
    const pending = games.download(post());
    await extracting;
    if (logout) await games.account(null);
    else await games.remove('game1');
    release();
    await pending;
    await games.account('alice');
    assert.equal((await games.list()).length, 0);
  }
});

test('saved content never overrides HTTP denials, external APIs or an aborted request', async () => {
  const f = fixture();
  const games = f.make();
  await games.account('alice');
  await games.download(post());
  const denied = games.wrap(async () => new Response(null, { status: 403 }));
  assert.equal((await denied('/api/bookmarks')).status, 403);
  assert.equal((await denied('https://external.example/api/bookmarks')).status, 403);
  const unavailable = games.wrap(async () => new Response(null, { status: 503 }));
  assert.equal((await unavailable('/api/bookmarks')).status, 503);
  const offline = games.wrap(async () => {
    throw new TypeError('offline');
  });
  await assert.rejects(offline('/api/bookmarks', { headers: { Authorization: 'Bearer another-account' } }));
  await assert.rejects(offline('/api/bookmarks', { headers: { Range: 'bytes=0-10' } }));
  assert.equal((await offline('/api/bookmarks', { cache: 'no-store' })).status, 503);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(denied('/api/bookmarks', { signal: controller.signal }), { name: 'AbortError' });
});

test('an unresponsive native transport reaches its deadline instead of blocking the download queue', async (t) => {
  let started = false;
  const games = createOfflineGames({
    store: createOfflineGameStore(new IDBFactory()),
    online: () => true,
    network: async () => {
      started = true;
      return new Promise<Response>(() => {});
    },
    extract: async () => files(),
  });
  await games.account('alice');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = games.download(post());
  while (!started) await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(30_001);
  await pending;
  assert.equal(games.states.get('game1'), 'error');
});

test('standalone HTML downloads do not require a ZIP extractor', async () => {
  const games = createOfflineGames({
    store: createOfflineGameStore(new IDBFactory()),
    online: () => true,
    network: async (input) =>
      new URL((input as Request).url).pathname.endsWith('/archive')
        ? new Response('<button>Play</button>')
        : Response.json({
            postId: 'game1',
            revision: 'a'.repeat(64),
            format: 'html',
            cacheable: true,
            archiveUrl: 'https://flaxia.app/api/game-loader/game1/archive',
          }),
    extract: async () => assert.fail('HTML must not be parsed as ZIP'),
  });
  await games.account('alice');
  await games.download({ ...post(), payload_key: 'html/game1.html' });
  assert.equal(games.states.get('game1'), 'saved');
  assert.equal(new TextDecoder().decode((await games.files('game1'))?.[0].bytes), '<button>Play</button>');
});

test('quickly bookmarking two games downloads both without cancelling the first metadata lookup', async () => {
  const f = fixture();
  const games = f.make();
  await games.account('alice');
  const fetch = games.wrap(async () => Response.json({ bookmarked: true }));
  await Promise.all([
    fetch('/api/posts/first/bookmark', { method: 'POST' }),
    fetch('/api/posts/second/bookmark', { method: 'POST' }),
  ]);
  for (let attempt = 0; attempt < 100 && (await games.list()).length < 2; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual((await games.list()).map((game) => game.id).sort(), ['first', 'second']);
});

test('store commits atomically, isolates accounts and rejects stale writers or over-budget games', async () => {
  const store = createOfflineGameStore(new IDBFactory());
  await store.activate('alice');
  const game: DownloadedGame = {
    id: 'game1',
    owner: 'alice',
    post: post(),
    revision: 'a'.repeat(64),
    savedAt: Date.now(),
    files: files(),
    size: 100,
  };
  await assert.rejects(store.put(game, () => false));
  assert.equal((await store.list('alice')).length, 0);
  await store.put(game, () => true);
  assert.equal(await store.get('game1', 'bob'), undefined);
  await assert.rejects(store.put({ ...game, id: 'large', size: 251 * 1024 * 1024 }, () => true));
  assert.equal((await store.get('game1', 'alice'))?.files.length, 1);
  await store.activate('bob');
  await assert.rejects(store.put(game, () => true));
  assert.equal((await store.list('alice')).length, 0);
});
