import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createOfflineFetch, isOfflineReadable } from '../src/lib/offline-fetch.ts';
import { createOfflineStore, type OfflineStore } from '../src/lib/offline-store.ts';

function client(network: typeof fetch, store = createOfflineStore(new IDBFactory())) {
  let online = true;
  let offline = false;
  let time = Date.now();
  const options = {
    store,
    baseUrl: 'https://localhost/',
    apiOrigin: 'https://flaxia.app',
    isOnline: () => online,
    setOffline: (value: boolean) => {
      offline = value;
    },
    now: () => time,
  };
  return {
    fetch: createOfflineFetch(network, options),
    restart: () => createOfflineFetch(network, options),
    store,
    setOnline: (value: boolean) => {
      online = value;
    },
    advance: (value: number) => {
      time += value;
    },
    offline: () => offline,
  };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const me = (id: string) =>
  json({ user: { id, username: id, display_name: id, email: 'secret@example.com', ng_words: ['secret'] } });

test('a restarted client restores a sanitized identity and saved feed without network', async () => {
  let calls = 0;
  const c = client(async (input) => {
    calls++;
    return (input as Request).url.endsWith('/api/me') ? me('alice') : json({ posts: ['saved'] });
  });
  assert.equal((await (await c.fetch('/api/me')).json()).user.email, 'secret@example.com');
  await c.fetch('/api/posts?limit=20');
  c.setOnline(false);
  const restarted = c.restart();
  assert.deepEqual(await (await restarted('/api/me')).json(), {
    user: { id: 'alice', username: 'alice', display_name: 'alice' },
  });
  const response = await restarted('/api/posts?limit=20');
  assert.equal(response.headers.get('X-Flaxia-Offline'), '1');
  assert.deepEqual(await response.json(), { posts: ['saved'] });
  assert.equal(calls, 2);
  assert.equal(c.offline(), true);
});
test('reconnect fetches fresh data and replaces the saved snapshot', async () => {
  let value = 'before';
  const c = client(async () => json({ value }));
  await c.fetch('/api/posts');
  c.setOnline(false);
  assert.equal((await (await c.fetch('/api/posts')).json()).value, 'before');
  c.setOnline(true);
  value = 'after';
  assert.equal((await c.fetch('/api/posts')).headers.has('X-Flaxia-Offline'), false);
  assert.equal(c.offline(), false);
  c.setOnline(false);
  assert.equal((await (await c.restart()('/api/posts')).json()).value, 'after');
});
test('feeds, cursors, and private images do not share cached entries', async () => {
  const c = client(async () => json({ posts: [] }));
  await c.fetch('/api/posts?limit=20');
  c.setOnline(false);
  for (const path of [
    '/api/posts?following=true&limit=20',
    '/api/posts?limit=20&cursor=next',
    '/api/images/dm/secret',
  ]) {
    assert.equal((await c.fetch(path)).status, 503);
  }
  assert.equal(isOfflineReadable('/api/images/dm%2Fsecret'), false);
});
test('network failures use saved content but HTTP errors stay authoritative', async () => {
  let failure: number | 'network' | null = null;
  const c = client(async () => {
    if (failure === 'network') throw new TypeError('offline');
    return json({ posts: [] }, failure ?? 200);
  });
  await c.fetch('/api/posts');
  failure = 'network';
  assert.equal((await c.fetch('/api/posts')).status, 200);
  failure = 500;
  assert.equal((await c.fetch('/api/posts')).status, 500);
  failure = 403;
  assert.equal((await c.fetch('/api/posts')).status, 403);
  c.setOnline(false);
  assert.equal((await c.fetch('/api/posts')).status, 503);
});
test('responses and saved identities expire after seven days', async () => {
  const c = client(async (input) => ((input as Request).url.endsWith('/api/me') ? me('alice') : json({ posts: [] })));
  await c.fetch('/api/me');
  await c.fetch('/api/posts');
  c.setOnline(false);
  c.advance(7 * 24 * 60 * 60 * 1000 + 1);
  assert.equal((await c.fetch('/api/posts')).status, 503);
  assert.equal((await c.restart()('/api/me')).status, 503);
});
test('logout clears saved content and in-flight responses cannot restore it', async () => {
  let resolveFeed: ((response: Response) => void) | undefined;
  const c = client(async (input) => {
    const path = new URL((input as Request).url).pathname;
    if (path === '/api/me') return me('alice');
    if (path === '/api/auth/logout') return json({ success: true });
    return new Promise<Response>((resolve) => {
      resolveFeed = resolve;
    });
  });
  await c.fetch('/api/me');
  const pending = c.fetch('/api/posts');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await c.fetch('/api/auth/logout', { method: 'POST' });
  assert.ok(resolveFeed);
  resolveFeed(json({ posts: ['alice only'] }));
  await pending;
  c.setOnline(false);
  assert.equal((await c.restart()('/api/me')).status, 503);
  assert.equal((await c.fetch('/api/posts')).status, 503);
});
test('account switching and session expiration clear previous account data', async () => {
  let account: string | null = 'alice';
  const c = client(async (input) =>
    (input as Request).url.endsWith('/api/me')
      ? account
        ? me(account)
        : json({ error: 'unauthorized' }, 401)
      : json({ posts: ['alice'] }),
  );
  await c.fetch('/api/me');
  await c.fetch('/api/posts');
  account = 'bob';
  await c.fetch('/api/me');
  c.setOnline(false);
  assert.equal((await c.fetch('/api/posts')).status, 503);
  assert.equal((await (await c.restart()('/api/me')).json()).user.id, 'bob');
  c.setOnline(true);
  account = null;
  assert.equal((await c.fetch('/api/me')).status, 401);
  c.setOnline(false);
  assert.equal((await c.restart()('/api/me')).status, 503);
});
test('Auth exchange clears the previous account offline data', async () => {
  const c = client(async (input) =>
    (input as Request).url.endsWith('/api/me') ? me('alice') : json({ posts: ['alice'] }),
  );
  await c.fetch('/api/me');
  await c.fetch('/api/posts');
  await c.fetch('/api/auth/flaxia/exchange', { method: 'POST' });
  c.setOnline(false);
  assert.equal((await c.fetch('/api/posts')).status, 503);
  assert.equal((await c.restart()('/api/me')).status, 503);
});
test('offline mutations fail and are never replayed', async () => {
  const calls: string[] = [];
  const c = client(async (input) => {
    calls.push((input as Request).method);
    return json({ posts: [] });
  });
  c.setOnline(false);
  await assert.rejects(
    c.fetch('/api/posts/prepare', { method: 'POST', body: '{}' }),
    /requires an internet connection/,
  );
  c.setOnline(true);
  await c.fetch('/api/posts');
  assert.deepEqual(calls, ['GET']);
});
test('sensitive endpoints, no-store requests, bearer tokens, and ranges never enter the cache', async () => {
  const c = client(async () => json({ secret: 'private' }));
  for (const path of [
    '/api/vault/keys',
    '/api/vault/items',
    '/api/notifications',
    '/api/billing/plan',
    '/api/admin/access',
    '/api/users/me',
    '/api/bookmarks',
  ]) {
    assert.equal(isOfflineReadable(path), false);
    await c.fetch(path);
    c.setOnline(false);
    assert.equal((await c.fetch(path)).status, 503);
    c.setOnline(true);
  }
  for (const init of [
    { cache: 'no-store' as const },
    { headers: { Authorization: 'Bearer secret' } },
    { headers: { Range: 'bytes=0-10' } },
  ]) {
    await c.fetch('/api/posts', init);
  }
  c.setOnline(false);
  assert.equal((await c.fetch('/api/posts')).status, 503);
});
test('binary images persist, but oversized and server no-store responses do not', async () => {
  const c = client(async (input) => {
    const path = new URL((input as Request).url).pathname;
    if (path.startsWith('/api/images/'))
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
    if (path === '/api/posts') return json({ text: 'x'.repeat(1024 * 1024) });
    return Response.json({ posts: [] }, { headers: { 'Cache-Control': 'no-store' } });
  });
  await c.fetch('https://flaxia.app/api/images/posts/image.png');
  await c.fetch('/api/posts');
  await c.fetch('/api/posts/recommended');
  c.setOnline(false);
  const image = await c.restart()('https://flaxia.app/api/images/posts/image.png');
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal((await c.fetch('/api/posts')).status, 503);
  assert.equal((await c.fetch('/api/posts/recommended')).status, 503);
});
test('storage failures do not break successful online requests', async () => {
  const fail = async (): Promise<never> => {
    throw new Error('quota');
  };
  const store: OfflineStore = { get: fail, put: fail, delete: fail, clear: fail };
  const c = client(async () => json({ value: 'online' }), store);
  assert.equal((await (await c.fetch('/api/posts')).json()).value, 'online');
});
test('aborted requests do not return cached results', async () => {
  const c = client(async () => json({ posts: [] }));
  await c.fetch('/api/posts');
  c.setOnline(false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(c.fetch('/api/posts', { signal: controller.signal }), { name: 'AbortError' });
});

test('a stalled read reaches the deadline and restores cached data', async (t) => {
  let stalled = false;
  let started = false;
  let signal: AbortSignal | undefined;
  const c = client(async (input) => {
    if (!stalled) return json({ posts: ['saved'] });
    started = true;
    signal = (input as Request).signal;
    return new Promise<Response>(() => {});
  });
  await c.fetch('/api/posts');
  stalled = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = c.fetch('/api/posts');
  while (!started) await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(8001);
  const response = await pending;
  assert.deepEqual(await response.json(), { posts: ['saved'] });
  assert.equal(response.headers.get('X-Flaxia-Offline'), '1');
  assert.equal(signal?.aborted, true);
});
test('storage evicts oldest responses within its count and size budgets', async () => {
  const store = createOfflineStore(new IDBFactory());
  await store.put({ key: 'identity', body: new Blob(['identity']), savedAt: 0 });
  for (let i = 0; i < 101; i++) await store.put({ key: String(i), body: new Blob(['small']), savedAt: i + 1 });
  assert.equal(await store.get('0'), undefined);
  assert.ok(await store.get('100'));
  assert.ok(await store.get('identity'));
  for (let i = 0; i < 3; i++)
    await store.put({ key: 'large-' + i, body: new Blob([new Uint8Array(8 * 1024 * 1024)]), savedAt: 1000 + i });
  assert.equal(await store.get('large-0'), undefined);
  assert.ok(await store.get('large-2'));
  assert.ok(await store.get('identity'));
});

test('reauthentication and SRP upgrades preserve the saved identity and feed, including failures', async () => {
  const c = client(async (input) => {
    const path = new URL((input as Request).url).pathname;
    if (path === '/api/me') return me('alice');
    if (path.startsWith('/api/auth/')) return json({ error: 'wrong proof' }, 403);
    return json({ posts: ['saved'] });
  });
  await c.fetch('/api/me');
  await c.fetch('/api/posts');
  for (const path of ['/api/auth/reauth/start', '/api/auth/reauth/verify', '/api/auth/upgrade-srp']) {
    await c.fetch(path, { method: 'POST' });
  }
  c.setOnline(false);
  assert.equal((await (await c.restart()('/api/me')).json()).user.id, 'alice');
  assert.deepEqual(await (await c.restart()('/api/posts')).json(), { posts: ['saved'] });
});

test('unrelated successes cannot hide a saved-feed warning; refreshing that feed clears it', async () => {
  let fail = false;
  const c = client(async (input) => {
    if (new URL((input as Request).url).pathname === '/api/posts' && fail) throw new TypeError('offline');
    return json({ posts: ['saved'] });
  });
  await c.fetch('/api/posts');
  fail = true;
  assert.equal((await c.fetch('/api/posts')).headers.get('X-Flaxia-Offline'), '1');
  await c.fetch('/api/notifications');
  await c.fetch('/api/images/avatar.png');
  assert.equal(c.offline(), true);
  fail = false;
  await c.fetch('/api/posts');
  assert.equal(c.offline(), false);
});

for (const savedPage of [false, true]) {
  test(`refreshing a feed clears its offline pagination warning (saved page: ${savedPage})`, async () => {
    const c = client(async (input) =>
      new URL((input as Request).url).pathname === '/api/me' ? me('alice') : json({ posts: ['fresh'] }),
    );
    await c.fetch('/api/me');
    await c.fetch('/api/posts?limit=20');
    if (savedPage) await c.fetch('/api/posts?cursor=old&limit=20');
    c.setOnline(false);
    await c.fetch('/api/posts?limit=20');
    assert.equal((await c.fetch('/api/posts?cursor=old&limit=20')).status, savedPage ? 200 : 503);
    c.setOnline(true);
    await c.fetch('/api/me');
    await c.fetch('/api/posts?limit=20');
    assert.equal(c.offline(), false);
  });
}

test('refreshing another feed or receiving an HTTP error does not clear saved pages', async () => {
  let status = 200;
  const c = client(async () => json({ posts: [] }, status));
  await c.fetch('/api/posts?following=true&limit=20&cursor=old');
  c.setOnline(false);
  await c.fetch('/api/posts?following=true&limit=20&cursor=old');
  c.setOnline(true);
  await c.fetch('/api/posts?limit=20');
  await c.fetch('/api/posts/recommended?following=true&limit=20');
  assert.equal(c.offline(), true);
  status = 500;
  await c.fetch('/api/posts?limit=20&following=true');
  assert.equal(c.offline(), true);
  status = 200;
  await c.fetch('/api/posts?limit=20&following=true');
  assert.equal(c.offline(), false);
});

test('an uncached failed read does not keep the banner after connectivity recovers', async () => {
  const c = client(async () => json({ posts: [] }));
  c.setOnline(false);
  assert.equal((await c.fetch('/api/posts?cursor=missing')).status, 503);
  c.setOnline(true);
  await c.fetch('/api/posts');
  assert.equal(c.offline(), false);
});
