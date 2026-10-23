import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { launchWithFallback } from '../sandbox/game-loader/launch.js';
import { servePublicLoader } from '../src/lib/game-loader-public.ts';

test('cache miss displays WVFS before starting persistence and does not await persistence', async () => {
  const events: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = await launchWithFallback({
    probe: async () => null,
    playCached: async () => assert.fail('no cache'),
    playWvfs: async () => {
      events.push('display');
    },
    schedule: (task: () => Promise<void>) => {
      events.push('schedule');
      return task();
    },
    warm: async () => {
      events.push('write');
      await pending;
    },
  });
  assert.equal(result.mode, 'wvfs');
  assert.deepEqual(events, ['display', 'schedule', 'write']);
  finish();
  await result.background;
});

test('healthy cache plays once without WVFS or a background download', async () => {
  const cached = { files: [] };
  const result = await launchWithFallback({
    probe: async () => cached,
    playCached: async (value: unknown) => assert.equal(value, cached),
    playWvfs: async () => assert.fail('unexpected fallback'),
    schedule: () => assert.fail('unexpected schedule'),
    warm: () => assert.fail('unexpected warm'),
  });
  assert.equal(result.mode, 'cache');
});

test('slow cache cannot hold WVFS or replace a game that already started', async () => {
  let finish!: (value: object) => void;
  const probe = new Promise((resolve) => {
    finish = resolve;
  });
  let displays = 0;
  const result = await launchWithFallback({
    timeoutMs: 5,
    probe: () => probe,
    playCached: async () => assert.fail('late cache cannot start a second game'),
    playWvfs: async () => {
      displays++;
    },
    warm: async () => {},
    schedule: (task: () => Promise<void>) => task(),
  });
  assert.equal(result.reason, 'timeout');
  finish({ files: [] });
  await result.background;
  assert.equal(displays, 1);
});

test('loader preparation errors fall back, and cache errors do not fail playback', async () => {
  for (const stage of ['probe', 'play']) {
    let displays = 0;
    const result = await launchWithFallback({
      probe: async () => {
        if (stage === 'probe') throw new Error('SW unavailable');
        return {};
      },
      playCached: async () => {
        throw new Error('Unsupported module');
      },
      playWvfs: async () => {
        displays++;
      },
      schedule: (task: () => Promise<void>) => task(),
      warm: async () => {
        throw new Error('Quota exceeded');
      },
    });
    assert.equal(result.reason, 'loader-error');
    await result.background;
    assert.equal(displays, 1);
  }
});

test('failed WVFS navigation cannot trigger a background download', async () => {
  await assert.rejects(
    launchWithFallback({
      probe: async () => null,
      playCached: async () => {},
      playWvfs: async () => {
        throw new Error('navigation failed');
      },
      schedule: () => assert.fail('not displayed'),
      warm: () => assert.fail('not displayed'),
    }),
    /navigation failed/,
  );
});

function publicApi() {
  let hidden = false;
  let blocked = false;
  let etag = 'source-1';
  let read = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes('FROM posts'))
            return { payload_key: 'zip/public-game.zip', status: 'published', hidden: hidden ? 1 : 0 };
          return null;
        },
      };
    },
  } as unknown as D1Database;
  const bucket = {
    async head() {
      return { etag, size: 3 };
    },
    async get(_key: string, options: { onlyIf: { etagMatches: string } }) {
      read++;
      assert.equal(options.onlyIf.etagMatches, etag);
      return { body: new Uint8Array([1, 2, 3]), size: 3 };
    },
  } as unknown as R2Bucket;
  const app = new Hono<{ Bindings: { DB: D1Database; BUCKET: R2Bucket; CACHE: KVNamespace } }>();
  app.get('/api/game-loader/:postId', (c) => servePublicLoader(c));
  app.get('/api/game-loader/:postId/archive', (c) => servePublicLoader(c));
  const env = {
    DB: db,
    BUCKET: bucket,
    CACHE: { get: async () => (blocked ? 'blocked' : null) } as unknown as KVNamespace,
  };
  return {
    fetch: (path = '/api/game-loader/public-game') =>
      app.request(new URL(path, 'https://sandbox.example').href, {}, env),
    hide: () => {
      hidden = true;
    },
    block: () => {
      blocked = true;
    },
    update: () => {
      etag = 'source-2';
    },
    reads: () => read,
  };
}

test('public descriptors never serve archives until requested; changed sources reject stale downloads', async () => {
  const api = publicApi();
  const response = await api.fetch();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const descriptor = (await response.json()) as { archiveUrl: string; revision: string };
  assert.match(descriptor.revision, /^[a-f0-9]{64}$/);
  assert.equal(api.reads(), 0);
  const archive = await api.fetch(descriptor.archiveUrl);
  assert.equal(archive.status, 200);
  assert.equal(api.reads(), 1);
  api.update();
  assert.equal((await api.fetch(descriptor.archiveUrl)).status, 409);
  assert.equal(api.reads(), 1);
});

test('publication and scan checks reject cached launches and archive requests', async () => {
  for (const reason of ['hidden', 'blocked']) {
    const api = publicApi();
    const descriptor = (await (await api.fetch()).json()) as { archiveUrl: string };
    if (reason === 'hidden') api.hide();
    else api.block();
    assert.equal((await api.fetch()).status, 404);
    assert.equal((await api.fetch(descriptor.archiveUrl)).status, 404);
    assert.equal(api.reads(), 0);
  }
});
