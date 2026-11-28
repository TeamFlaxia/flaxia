// On-demand discovery for the federated feed: cold database, atomic D1 lock,
// bounded run.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import {
  discoverForEmptyFeed,
  ONDEMAND_LOCK_KEY,
  ONDEMAND_OPTIONS,
  runDiscoveryForRequest,
} from '../functions/api/routes/federated-discovery.ts';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { PoolResult } from '../functions/lib/activitypub/ap-pool.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// Route modules use extensionless relative imports for the Worker bundler.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
}
`),
);

const { default: federatedRouter } = await import('../functions/api/routes/federated.ts');

type AppEnv = { Bindings: Bindings; Variables: Variables };
type TestStatement = ReturnType<TestDatabase['prepare']>;

function wrapStatement(statement: TestStatement): TestStatement {
  return {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
    first: <T>() => statement.first<T>(),
    all: async <T>() => ({ ...(await statement.all<T>()), success: true }) as { results: T[] },
    run: () => statement.run(),
  } as TestStatement;
}

function wrapDb(database: TestDatabase): TestDatabase {
  return {
    prepare: (sql: string) => wrapStatement(database.prepare(sql)),
    batch: (statements: TestStatement[]) => database.batch(statements),
    exec: (sql: string) => database.exec(sql),
    close: () => database.close(),
  };
}

const DOMAIN = 'mastodon.test';
const ACTOR_URL = `https://${DOMAIN}/users/alice`;
const OBJECT_ID = `${ACTOR_URL}/statuses/1`;
const CREATED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const databases: TestDatabase[] = [];
let db: TestDatabase;

beforeEach(() => {
  db = createTestDatabase();
  databases.push(db);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ap_pool_metrics (
       post_id TEXT PRIMARY KEY, instance TEXT NOT NULL, favourites INTEGER NOT NULL DEFAULT 0,
       reblogs INTEGER NOT NULL DEFAULT 0, score REAL NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL
     )`,
  );
  db.prepare('DELETE FROM posts').run();
  db.prepare('DELETE FROM ap_pool_metrics').run();
  db.prepare('DELETE FROM ap_discovery_locks').run();
  db.prepare(
    `INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, display_name, icon_url, domain, fetched_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(ACTOR_URL, `${ACTOR_URL}/inbox`, 'alice', 'Alice', DOMAIN, CREATED_AT)
    .run();
});

after(() => {
  for (const database of databases) database.close();
});

function envFor(cache?: Bindings['CACHE']): Bindings {
  return {
    DB: wrapDb(db) as unknown as Bindings['DB'],
    CACHE: cache as Bindings['CACHE'],
    BASE_URL: 'https://flaxia.app',
    ENVIRONMENT: 'test',
    AP_POOL_SEED_DOMAINS: DOMAIN,
  } as Bindings;
}

const emptyResult: PoolResult = {
  instances: 0,
  fetched: 0,
  stored: 0,
  inserted: 0,
  refreshed: 0,
  skipped: 0,
  errors: 0,
};

/** NodeInfo + trends stub for one Mastodon instance. */
function mastodonFetch(): (url: string) => { body: unknown } | null {
  return (url) => {
    if (url === `https://${DOMAIN}/.well-known/nodeinfo`) {
      return {
        body: {
          links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `https://${DOMAIN}/nodeinfo/2.1` }],
        },
      };
    }
    if (url === `https://${DOMAIN}/nodeinfo/2.1`) {
      return { body: { software: { name: 'mastodon' }, protocols: ['activitypub'] } };
    }
    if (url.startsWith(`https://${DOMAIN}/api/v1/trends/statuses`)) {
      return {
        body: [
          {
            id: '1',
            url: `https://${DOMAIN}/@alice/1`,
            content: '<p>Discovered on demand</p>',
            created_at: CREATED_AT,
            visibility: 'public',
            account: { url: ACTOR_URL, acct: 'alice', display_name: 'Alice' },
            favourites_count: 4,
            reblogs_count: 2,
          },
        ],
      };
    }
    return null;
  };
}

function stubFetch(handler: (url: string) => { body: unknown } | null): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const result = handler(String(input));
    if (!result) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(result.body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function appFor(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', null);
    await next();
  });
  app.route('/', federatedRouter);
  return app;
}

async function getFeed(app: Hono<AppEnv>, env: Bindings): Promise<{ posts: Array<Record<string, unknown>> }> {
  const response = await app.request('http://localhost/federated/posts', {}, env);
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${await response.clone().text()}`);
  return (await response.json()) as { posts: Array<Record<string, unknown>> };
}

async function lockRows(): Promise<Array<{ key: string }>> {
  const result = await db.prepare('SELECT key FROM ap_discovery_locks').all<{ key: string }>();
  return result.results;
}

describe('federated on-demand discovery', () => {
  it('discovers and returns seeded posts when the pool and remote posts are both empty', async () => {
    const restore = stubFetch(mastodonFetch());
    try {
      const data = await getFeed(appFor(), envFor());
      assert.equal(data.posts.length, 1);
      assert.equal(data.posts[0].ap_object_id, OBJECT_ID);
      assert.equal(data.posts[0].text, 'Discovered on demand');
      assert.ok(Number(data.posts[0].pool_score) > 0);
      // A productive run releases its lock so the next cold request may retry.
      assert.equal((await lockRows()).length, 0);
    } finally {
      restore();
    }
  });

  it('does not discover when another run holds the atomic lock', async () => {
    db.prepare('INSERT INTO ap_discovery_locks (key, owner, expires_at) VALUES (?, ?, ?)')
      .bind(ONDEMAND_LOCK_KEY, 'other', Date.now() + 300_000)
      .run();
    let calls = 0;
    const ran = await discoverForEmptyFeed(envFor(), async () => {
      calls++;
      return emptyResult;
    });
    assert.equal(ran, false);
    assert.equal(calls, 0);
  });

  it('sets the lock before starting a bounded run and keeps it on a dry run', async () => {
    let seenOptions: typeof ONDEMAND_OPTIONS | null = null;
    let lockDuringRun = 0;
    const ran = await discoverForEmptyFeed(envFor(), async (_env, options) => {
      seenOptions = options;
      lockDuringRun = (await lockRows()).length;
      return emptyResult;
    });
    assert.equal(ran, true);
    assert.equal(lockDuringRun, 1, 'the lock must exist while discovery runs');
    assert.deepEqual(seenOptions, { maxInstances: 4, maxPostsPerInstance: 40, maxTotal: 500, maxRefreshes: 0 });
    assert.equal((await lockRows()).length, 1, 'a dry run keeps the lock until its TTL');
  });

  it('discovers even when CACHE is absent', async () => {
    let calls = 0;
    const ran = await discoverForEmptyFeed(envFor(undefined), async () => {
      calls++;
      return emptyResult;
    });
    assert.equal(ran, true);
    assert.equal(calls, 1);
  });

  it('swallows runner errors and keeps the lock', async () => {
    let calls = 0;
    const ran = await discoverForEmptyFeed(envFor(), async () => {
      calls++;
      throw new Error('peer unavailable');
    });
    assert.equal(ran, false);
    assert.equal(calls, 1, 'the runner must actually be invoked before the error is swallowed');
    assert.equal((await lockRows()).length, 1, 'a failed run keeps the lock until its TTL');
  });

  it('passes the available bindings into a correctly shaped pool env', async () => {
    const env = envFor();
    let seen: Record<string, unknown> | null = null;
    await runDiscoveryForRequest(env, ONDEMAND_OPTIONS, async (poolEnv, options) => {
      seen = poolEnv as unknown as Record<string, unknown>;
      assert.deepEqual(options, ONDEMAND_OPTIONS);
      return emptyResult;
    });
    assert.ok(seen);
    assert.equal(seen!.DB, env.DB);
    assert.equal(seen!.CACHE, env.CACHE);
    assert.equal(seen!.BASE_URL, 'https://flaxia.app');
    assert.equal(seen!.ENVIRONMENT, 'test');
    assert.equal(seen!.AP_POOL_SEED_DOMAINS, DOMAIN);
    assert.equal(seen!.AP_ALLOWED_PRIVATE_PEERS, undefined);
  });
});
