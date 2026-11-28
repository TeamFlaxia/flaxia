import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computePoolScore,
  normalizeMastodonStatus,
  POOL_JOIN_SQL,
  POOL_SCORE_SQL,
  type PoolActorInfo,
  type PoolEnv,
  prunePool,
  runPoolDiscovery,
} from '../functions/lib/activitypub/ap-pool.ts';
import { handleIncomingActivity } from '../functions/lib/activitypub/handlers.ts';
import { freshnessBoost } from '../functions/lib/scoring.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

const BASE = 'https://flaxia.app';
const DOMAIN = 'mastodon.test';
const ACTOR_URL = `https://${DOMAIN}/users/alice`;
const OBJECT_ID = `${ACTOR_URL}/statuses/1`;
const CREATED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function envFor(db: TestDatabase, overrides: Partial<PoolEnv> = {}): PoolEnv {
  return {
    DB: db as unknown as PoolEnv['DB'],
    BASE_URL: BASE,
    AP_POOL_SEED_DOMAINS: DOMAIN,
    ...overrides,
  };
}

/** Pin `Date.now()` so score and fetched_at assertions are deterministic. */
function withNow<T>(now: number, fn: () => T): T {
  const original = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

async function withNowAsync<T>(now: number, fn: () => Promise<T>): Promise<T> {
  const original = Date.now;
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}

/** `freshnessBoost` reads `Date.now()`; pin it so score assertions are deterministic. */
function withFixedNow<T>(fn: () => T): T {
  return withNow(Date.parse(CREATED_AT) + 60 * 60 * 1000, fn);
}

function actorInfo(overrides: Partial<PoolActorInfo> = {}): PoolActorInfo {
  return {
    actorUrl: ACTOR_URL,
    domain: DOMAIN,
    username: `alice@${DOMAIN}`,
    displayName: 'Alice',
    iconUrl: `https://${DOMAIN}/avatar.png`,
    ...overrides,
  };
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OBJECT_ID,
    url: `https://${DOMAIN}/@alice/1`,
    content: '<p>Hello <b>world</b> &amp; friends</p><script>alert(1)</script>',
    created_at: CREATED_AT,
    visibility: 'public',
    account: {
      url: ACTOR_URL,
      acct: 'alice',
      display_name: 'Alice',
      avatar: `https://${DOMAIN}/avatar.png`,
      note: '<p>Hi there</p>',
    },
    favourites_count: 3,
    reblogs_count: 2,
    ...overrides,
  };
}

type TaggedStatement = ReturnType<TestDatabase['prepare']> & { readonly sql: string };

/**
 * A D1-like DB that fails a batch containing the metrics insert before running
 * any statement. D1 batches are atomic, so this models a failed transaction:
 * the post insert in the same batch must be rolled back as well.
 */
function failMetricsBatch(db: TestDatabase): PoolEnv['DB'] {
  const prepare = (sql: string, values: unknown[] = []): TaggedStatement => {
    const statement = values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
    return {
      bind: (...next: unknown[]) => prepare(sql, [...values, ...next]),
      first: <T>() => statement.first<T>(),
      all: <T>() => statement.all<T>(),
      run: () => statement.run(),
      sql,
    };
  };
  return {
    prepare,
    batch: async (statements: ReturnType<TestDatabase['prepare']>[]) => {
      if (statements.some((statement) => (statement as TaggedStatement).sql?.includes('INSERT INTO ap_pool_metrics'))) {
        throw new Error('injected ap_pool_metrics insert failure');
      }
      return db.batch(statements);
    },
  } as unknown as PoolEnv['DB'];
}

/** Replace global fetch with a deterministic fake and return its restorer. */
function stubFetch(handler: (url: string) => { status?: number; body: unknown } | null): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const result = handler(url);
    if (!result) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** NodeInfo + trends stub for a Mastodon instance. */
function mastodonFetch(
  trends: unknown[],
  schema: '2.0' | '2.1' = '2.1',
): (url: string) => { status?: number; body: unknown } | null {
  return (url) => {
    if (url === `https://${DOMAIN}/.well-known/nodeinfo`) {
      return {
        body: {
          links: [
            {
              rel: `http://nodeinfo.diaspora.software/ns/schema/${schema}`,
              href: `https://${DOMAIN}/nodeinfo/${schema}`,
            },
          ],
        },
      };
    }
    if (url === `https://${DOMAIN}/nodeinfo/${schema}`) {
      return { body: { software: { name: 'mastodon' }, protocols: ['activitypub'] } };
    }
    if (url.startsWith(`https://${DOMAIN}/api/v1/trends/statuses`)) return { body: trends };
    return null;
  };
}

describe('federated popularity pool', () => {
  it('scores only the counters Mastodon REST statuses actually expose', () =>
    withFixedNow(() => {
      // Extra Flaxia-specific counters are not part of a Mastodon REST status;
      // even if a caller supplies them, they must not change the score.
      const params = {
        favourites: 4,
        reblogs: 9,
        createdAt: CREATED_AT,
        flaxiaFresh: 2,
        flaxiaReload: 3,
      };
      const expected = 1.0 * Math.log1p(4) + 2.0 * Math.log1p(9) + 1.5 * freshnessBoost(CREATED_AT);
      assert.equal(computePoolScore(params), expected);
      assert.equal(
        computePoolScore({ favourites: 0, reblogs: 0, createdAt: CREATED_AT }),
        1.5 * freshnessBoost(CREATED_AT),
      );
      // Bad counters must not poison the ranking with NaN.
      assert.ok(Number.isFinite(computePoolScore({ favourites: Number.NaN, reblogs: 9, createdAt: CREATED_AT })));
    }));

  it('ignores Flaxia-specific reaction counters on a Mastodon status', () =>
    withFixedNow(() => {
      const plain = normalizeMastodonStatus(status(), actorInfo(), BASE);
      const withReactions = normalizeMastodonStatus(
        status({ flaxia_fresh: 9, flaxia_reload: 7, fresh_count: 11, reload_count: 13 }),
        actorInfo(),
        BASE,
      );
      assert.ok(plain);
      assert.ok(withReactions);
      assert.equal(withReactions.metrics.score, computePoolScore({ favourites: 3, reblogs: 2, createdAt: CREATED_AT }));
      assert.equal(withReactions.metrics.score, plain.metrics.score);
    }));

  it('normalizes a Mastodon status into a plain-text remote post with metrics', () =>
    withFixedNow(() => {
      const result = normalizeMastodonStatus(status(), actorInfo(), BASE);
      assert.ok(result);
      assert.equal(result.post.user_id, '');
      assert.equal(result.post.username, `alice@${DOMAIN}`);
      assert.equal(result.post.text, 'Hello world & friends');
      assert.equal(result.post.visibility, 'public');
      assert.equal(result.post.hidden, 0);
      assert.equal(result.post.status, 'published');
      assert.equal(result.post.ap_object_id, OBJECT_ID);
      assert.equal(result.post.actor_id, ACTOR_URL);
      assert.equal(result.post.created_at, CREATED_AT);
      assert.doesNotMatch(String(result.post.text), /<|script|&amp/);
      assert.equal(result.metrics.favourites, 3);
      assert.equal(result.metrics.reblogs, 2);
      assert.equal(result.metrics.score, computePoolScore({ favourites: 3, reblogs: 2, createdAt: CREATED_AT }));
    }));

  it('caps text at 200 characters and marks sensitive posts hidden', () => {
    const long = normalizeMastodonStatus(status({ content: `<p>${'あ'.repeat(300)}</p>` }), actorInfo(), BASE);
    assert.ok(long);
    assert.equal(String(long.post.text).length, 200);
    const sensitive = normalizeMastodonStatus(status({ sensitive: true }), actorInfo(), BASE);
    assert.equal(sensitive?.post.hidden, 1);
  });

  it('rejects boosts, private/direct statuses and unattributed or foreign statuses', () => {
    assert.equal(normalizeMastodonStatus(status({ reblog: { id: 'x' } }), actorInfo(), BASE), null);
    assert.equal(normalizeMastodonStatus(status({ visibility: 'private' }), actorInfo(), BASE), null);
    assert.equal(normalizeMastodonStatus(status({ visibility: 'direct' }), actorInfo(), BASE), null);
    assert.equal(normalizeMastodonStatus(status({ visibility: 'unlisted' }), actorInfo(), BASE), null);

    const otherAuthor = status({ account: { url: `https://${DOMAIN}/users/bob`, acct: 'bob' } });
    assert.equal(normalizeMastodonStatus(otherAuthor, actorInfo(), BASE), null);
    assert.equal(
      normalizeMastodonStatus(status({ attributedTo: `https://${DOMAIN}/users/bob` }), actorInfo(), BASE),
      null,
    );
    // Mastodon ids are often numeric; the absolute `url` is then the object id.
    assert.ok(normalizeMastodonStatus(status({ id: '12345' }), actorInfo(), BASE));
    assert.equal(normalizeMastodonStatus(status({ id: 'relative-id', url: 'not-a-url' }), actorInfo(), BASE), null);
    assert.equal(normalizeMastodonStatus(status({ id: 'https://evil.example/post/1' }), actorInfo(), BASE), null);
    // A status hosted on our own origin must never be re-imported as remote.
    const local = normalizeMastodonStatus(
      status({ id: `${BASE}/notes/1`, account: { url: BASE, acct: 'alice' } }),
      actorInfo({ actorUrl: BASE, domain: 'flaxia.app' }),
      BASE,
    );
    assert.equal(local, null);
  });

  it('runs the exported join and score SQL against the real schema', async () => {
    const db = createTestDatabase();
    try {
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
           VALUES ('pooled', '', 'alice@mastodon.test', 'remote', 'published', ?, ?)`,
        )
        .bind(OBJECT_ID, CREATED_AT)
        .run();
      await db
        .prepare('INSERT INTO posts (id, user_id, username, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('local', 'u1', 'alice', 'local', 'published', CREATED_AT)
        .run();
      await db
        .prepare(
          `INSERT INTO ap_pool_metrics (post_id, instance, favourites, reblogs, score, fetched_at)
           VALUES ('pooled', ?, 3, 2, 4.25, ?)`,
        )
        .bind(DOMAIN, CREATED_AT)
        .run();

      const rows = await db
        .prepare(`SELECT p.id, ${POOL_SCORE_SQL} AS score FROM posts p ${POOL_JOIN_SQL} ORDER BY p.id`)
        .all<{ id: string; score: number }>();
      const byId = new Map(rows.results.map((row) => [row.id, row.score]));
      assert.equal(byId.get('pooled'), 4.25);
      assert.equal(byId.get('local'), 0);
    } finally {
      db.close();
    }
  });

  it('discovers Mastodon trends, stores the post and its metrics', async () => {
    const db = createTestDatabase();
    const restore = stubFetch(
      mastodonFetch([
        status(),
        status({ id: `${ACTOR_URL}/statuses/2`, reblog: { id: 'boost' } }),
        status({ id: `${ACTOR_URL}/statuses/3`, visibility: 'private' }),
      ]),
    );
    try {
      const result = await runPoolDiscovery(envFor(db));
      assert.deepEqual(result, {
        instances: 1,
        fetched: 3,
        stored: 1,
        inserted: 1,
        refreshed: 0,
        skipped: 2,
        errors: 0,
      });

      const post = await db
        .prepare('SELECT id, user_id, text, hidden, ap_object_id FROM posts WHERE ap_object_id = ?')
        .bind(OBJECT_ID)
        .first<{ id: string; user_id: string; text: string; hidden: number; ap_object_id: string }>();
      assert.ok(post);
      assert.equal(post.user_id, '');
      assert.equal(post.text, 'Hello world & friends');
      assert.equal(post.hidden, 0);

      const metrics = await db
        .prepare('SELECT instance, favourites, reblogs, score FROM ap_pool_metrics WHERE post_id = ?')
        .bind(post.id)
        .first<{ instance: string; favourites: number; reblogs: number; score: number }>();
      assert.ok(metrics);
      assert.equal(metrics.instance, DOMAIN);
      assert.equal(metrics.favourites, 3);
      assert.equal(metrics.reblogs, 2);
      assert.ok(metrics.score > 0);

      const author = await db
        .prepare('SELECT preferred_username, domain, summary FROM ap_actors WHERE actor_url = ?')
        .bind(ACTOR_URL)
        .first<{ preferred_username: string; domain: string; summary: string }>();
      assert.equal(author?.preferred_username, 'alice');
      assert.equal(author?.domain, DOMAIN);
      assert.equal(author?.summary, 'Hi there');
    } finally {
      restore();
      db.close();
    }
  });

  it('detects Mastodon from a nodeinfo 2.0-only document and fetches trends', async () => {
    const db = createTestDatabase();
    // mastodon.social advertises only schema 2.0; detection must still select
    // the Mastodon REST API instead of the outbox (which would fetch nothing).
    const baseFetch = mastodonFetch([status()], '2.0');
    let trendsFetches = 0;
    const restore = stubFetch((url) => {
      if (url.startsWith(`https://${DOMAIN}/api/v1/trends/statuses`)) trendsFetches++;
      return baseFetch(url);
    });
    try {
      const result = await runPoolDiscovery(envFor(db));
      assert.equal(trendsFetches, 1, 'the 2.0-only instance must use the Mastodon trends endpoint');
      assert.deepEqual(result, {
        instances: 1,
        fetched: 1,
        stored: 1,
        inserted: 1,
        refreshed: 0,
        skipped: 0,
        errors: 0,
      });
      const post = await db.prepare('SELECT ap_object_id FROM posts WHERE ap_object_id = ?').bind(OBJECT_ID).first();
      assert.ok(post, 'the trend status must be stored');
    } finally {
      restore();
      db.close();
    }
  });

  it('leaves no orphan post when the metrics write fails in the same batch', async () => {
    const db = createTestDatabase();
    const restore = stubFetch(mastodonFetch([status()]));
    try {
      const result = await runPoolDiscovery(envFor(db, { DB: failMetricsBatch(db) }));
      assert.equal(result.stored, 0);
      assert.equal(result.inserted, 0);
      assert.equal(result.errors, 1);
      const posts = await db
        .prepare('SELECT COUNT(*) AS count FROM posts WHERE ap_object_id = ?')
        .bind(OBJECT_ID)
        .first<{ count: number }>();
      assert.equal(posts?.count, 0, 'the public post must roll back with its metrics insert');
      const metrics = await db.prepare('SELECT COUNT(*) AS count FROM ap_pool_metrics').first<{ count: number }>();
      assert.equal(metrics?.count, 0);
    } finally {
      restore();
      db.close();
    }
  });

  it('does not write orphan metrics when INSERT OR IGNORE is a no-op', async () => {
    const db = createTestDatabase();
    const restore = stubFetch(mastodonFetch([status()]));
    const original = crypto.randomUUID;
    // randomPostId() slices the hex UUID to ten characters.
    const duplicateId = 'aaaaaaaabb';
    crypto.randomUUID = () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    try {
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
           VALUES (?, 'u1', 'local', 'existing local post', 'published', ?, ?)`,
        )
        .bind(duplicateId, `${ACTOR_URL}/statuses/different`, CREATED_AT)
        .run();
      const result = await runPoolDiscovery(envFor(db));
      assert.equal(result.stored, 0);
      assert.equal(result.skipped, 1);
      const posts = await db.prepare('SELECT text FROM posts WHERE id = ?').bind(duplicateId).first<{ text: string }>();
      assert.equal(posts?.text, 'existing local post');
      const metrics = await db
        .prepare('SELECT COUNT(*) AS count FROM ap_pool_metrics WHERE post_id = ?')
        .bind(duplicateId)
        .first<{ count: number }>();
      assert.equal(metrics?.count, 0, 'an ignored post insert must not create a metrics row');
    } finally {
      crypto.randomUUID = original;
      restore();
      db.close();
    }
  });

  it('skips an already known object id instead of duplicating it', async () => {
    const db = createTestDatabase();
    const restore = stubFetch(mastodonFetch([status()]));
    try {
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
           VALUES ('already-here', '', 'alice@mastodon.test', 'old copy', 'published', ?, ?)`,
        )
        .bind(OBJECT_ID, CREATED_AT)
        .run();
      const result = await runPoolDiscovery(envFor(db));
      assert.equal(result.stored, 0);
      assert.equal(result.skipped, 1);
      const count = await db
        .prepare('SELECT COUNT(*) AS count FROM posts WHERE ap_object_id = ?')
        .bind(OBJECT_ID)
        .first<{ count: number }>();
      assert.equal(count?.count, 1);
    } finally {
      restore();
      db.close();
    }
  });

  it('does not store posts of a blocked actor', async () => {
    const db = createTestDatabase();
    const restore = stubFetch(mastodonFetch([status()]));
    try {
      await seedLocalUser(db, { id: 'local-1', username: 'local', displayName: 'Local' });
      await db
        .prepare('INSERT INTO ap_blocks (id, local_user_id, actor_url) VALUES (?, ?, ?)')
        .bind('block-1', 'local-1', ACTOR_URL)
        .run();
      const result = await runPoolDiscovery(envFor(db));
      assert.equal(result.stored, 0);
      assert.equal(result.skipped, 1);
      const count = await db
        .prepare("SELECT COUNT(*) AS count FROM posts WHERE user_id = '' AND ap_object_id IS NOT NULL")
        .first<{ count: number }>();
      assert.equal(count?.count, 0);
      const actors = await db
        .prepare('SELECT COUNT(*) AS count FROM ap_actors WHERE actor_url = ?')
        .bind(ACTOR_URL)
        .first<{ count: number }>();
      assert.equal(actors?.count, 0);
    } finally {
      restore();
      db.close();
    }
  });

  it('falls back to one outbox page for a non-Mastodon instance', async () => {
    const db = createTestDatabase();
    const actor = `https://social.test/users/bob`;
    const noteId = `${actor}/notes/1`;
    await db
      .prepare(
        `INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, display_name, domain, fetched_at)
         VALUES (?, ?, 'bob', 'Bob', 'social.test', ?)`,
      )
      .bind(actor, `${actor}/inbox`, CREATED_AT)
      .run();
    const restore = stubFetch((url) => {
      if (url === 'https://social.test/.well-known/nodeinfo') {
        return {
          body: {
            links: [
              { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://social.test/nodeinfo/2.1' },
            ],
          },
        };
      }
      if (url === 'https://social.test/nodeinfo/2.1') {
        return { body: { software: { name: 'friendica' }, protocols: ['activitypub'] } };
      }
      if (url === actor) {
        return { body: { id: actor, type: 'Person', inbox: `${actor}/inbox`, outbox: `${actor}/outbox` } };
      }
      if (url === `${actor}/outbox`) {
        return {
          body: {
            type: 'OrderedCollection',
            totalItems: 1,
            orderedItems: [
              {
                type: 'Create',
                object: {
                  id: noteId,
                  type: 'Note',
                  attributedTo: actor,
                  content: '<p>From an outbox</p>',
                  published: CREATED_AT,
                  to: ['https://www.w3.org/ns/activitystreams#Public'],
                },
              },
            ],
          },
        };
      }
      return null;
    });
    try {
      const result = await runPoolDiscovery(envFor(db, { AP_POOL_SEED_DOMAINS: 'social.test' }));
      assert.deepEqual(result, {
        instances: 1,
        fetched: 1,
        stored: 1,
        inserted: 1,
        refreshed: 0,
        skipped: 0,
        errors: 0,
      });
      const metrics = await db
        .prepare(
          `SELECT pm.favourites, pm.reblogs, pm.instance FROM ap_pool_metrics pm JOIN posts p ON p.id = pm.post_id WHERE p.ap_object_id = ?`,
        )
        .bind(noteId)
        .first<{ favourites: number; reblogs: number; instance: string }>();
      assert.equal(metrics?.favourites, 0);
      assert.equal(metrics?.reblogs, 0);
      assert.equal(metrics?.instance, 'social.test');
    } finally {
      restore();
      db.close();
    }
  });

  it('respects the insert cap across instances', async () => {
    const db = createTestDatabase();
    const restore = stubFetch(mastodonFetch([status(), status({ id: `${ACTOR_URL}/statuses/2` })]));
    try {
      // Disable refreshes so the ceiling is unambiguously about insertions.
      const result = await runPoolDiscovery(envFor(db), { maxTotal: 1, maxPostsPerInstance: 40, maxRefreshes: 0 });
      assert.equal(result.inserted, 1);
      assert.equal(result.stored, 1);
      // Collection stops as soon as the ceiling is reached.
      assert.equal(result.fetched, 1);
      const count = await db
        .prepare("SELECT COUNT(*) AS count FROM posts WHERE user_id = '' AND ap_object_id IS NOT NULL")
        .first<{ count: number }>();
      assert.equal(count?.count, 1);
    } finally {
      restore();
      db.close();
    }
  });

  it('does not count refreshes against the new-post budget', async () => {
    const db = createTestDatabase();
    const restore = stubFetch(
      mastodonFetch([
        status(), // already in the pool
        status({ id: `${ACTOR_URL}/statuses/2` }),
        status({ id: `${ACTOR_URL}/statuses/3` }),
        status({ id: `${ACTOR_URL}/statuses/4` }),
      ]),
    );
    try {
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
           VALUES ('known', '', 'alice@mastodon.test', 'known', 'published', ?, ?)`,
        )
        .bind(OBJECT_ID, CREATED_AT)
        .run();
      await db
        .prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, 1, ?)')
        .bind('known', DOMAIN, CREATED_AT)
        .run();

      const result = await runPoolDiscovery(envFor(db), { maxTotal: 2 });
      assert.equal(result.refreshed, 1);
      assert.equal(result.inserted, 2, 'one refresh must not eat the insertion budget');
      assert.equal(result.stored, 3);
      assert.equal(result.fetched, 4);
      const count = await db
        .prepare("SELECT COUNT(*) AS count FROM posts WHERE user_id = '' AND ap_object_id IS NOT NULL")
        .first<{ count: number }>();
      assert.equal(count?.count, 3);
    } finally {
      restore();
      db.close();
    }
  });

  it('bounds refreshes with their own cap', async () => {
    const db = createTestDatabase();
    const second = `${ACTOR_URL}/statuses/2`;
    const restore = stubFetch(
      mastodonFetch([status(), status({ id: second }), status({ id: `${ACTOR_URL}/statuses/3` })]),
    );
    try {
      for (const [id, objectId] of [
        ['known-1', OBJECT_ID],
        ['known-2', second],
      ] as const) {
        await db
          .prepare(
            `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
             VALUES (?, '', 'alice@mastodon.test', 'known', 'published', ?, ?)`,
          )
          .bind(id, objectId, CREATED_AT)
          .run();
        await db
          .prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, 1, ?)')
          .bind(id, DOMAIN, CREATED_AT)
          .run();
      }
      const result = await runPoolDiscovery(envFor(db), { maxTotal: 2, maxRefreshes: 1 });
      assert.equal(result.refreshed, 1);
      assert.equal(result.inserted, 1);
      assert.equal(result.stored, 2);
      assert.equal(result.skipped, 1);
    } finally {
      restore();
      db.close();
    }
  });

  it('fetches a broken actor document only once for many statuses from that actor', async () => {
    const db = createTestDatabase();
    const brokenActor = `https://${DOMAIN}/users/broken`;
    const many = Array.from({ length: 12 }, (_, index) =>
      status({
        id: `${ACTOR_URL}/statuses/broken-${index}`,
        account: { url: brokenActor, acct: 'broken' },
      }),
    );
    let actorDocumentFetches = 0;
    const restore = stubFetch((url) => {
      if (url === brokenActor) {
        actorDocumentFetches++;
        // An id that disagrees with the requested URL makes resolution fail.
        return {
          body: { id: `https://${DOMAIN}/users/someone-else`, type: 'Person', inbox: `${brokenActor}/inbox` },
        };
      }
      return mastodonFetch(many)(url);
    });
    try {
      const result = await runPoolDiscovery(envFor(db), { maxPostsPerInstance: many.length });
      assert.equal(actorDocumentFetches, 1);
      assert.equal(result.fetched, 0);
      assert.equal(result.stored, 0);
      assert.equal(result.skipped, many.length);
      assert.equal(result.errors, 0);
    } finally {
      restore();
      db.close();
    }
  });

  it('does not repeat a failed WebFinger lookup for every status of the same account', async () => {
    const db = createTestDatabase();
    const many = Array.from({ length: 8 }, (_, index) =>
      status({ id: `${ACTOR_URL}/statuses/ghost-${index}`, account: { acct: 'ghost' } }),
    );
    const webfingerPrefix = `https://${DOMAIN}/.well-known/webfinger`;
    let webfingerFetches = 0;
    const restore = stubFetch((url) => {
      if (url.startsWith(webfingerPrefix)) {
        webfingerFetches++;
        return null; // 404: no such account on this instance
      }
      return mastodonFetch(many)(url);
    });
    try {
      const result = await runPoolDiscovery(envFor(db), { maxPostsPerInstance: many.length });
      assert.equal(webfingerFetches, 1);
      assert.equal(result.fetched, 0);
      assert.equal(result.skipped, many.length);
    } finally {
      restore();
      db.close();
    }
  });

  it('prunes only old remote pool rows and their metrics', async () => {
    const db = createTestDatabase();
    try {
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      for (const [id, createdAt, userId, objectId] of [
        ['old-remote', old, '', `${ACTOR_URL}/statuses/old`],
        ['new-remote', CREATED_AT, '', `${ACTOR_URL}/statuses/new`],
        ['old-local', old, 'u1', null],
      ] as const) {
        await db
          .prepare(
            `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
             VALUES (?, ?, 'alice', 'post', 'published', ?, ?)`,
          )
          .bind(id, userId, objectId, createdAt)
          .run();
        await db
          .prepare(`INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, 1, ?)`)
          .bind(id, DOMAIN, createdAt)
          .run();
      }
      const removed = await prunePool(envFor(db));
      assert.equal(removed, 2);

      const posts = await db
        .prepare("SELECT id FROM posts WHERE id IN ('old-remote', 'new-remote', 'old-local') ORDER BY id")
        .all<{ id: string }>();
      assert.deepEqual(
        posts.results.map((row) => row.id),
        ['new-remote', 'old-local'],
      );
      const metrics = await db
        .prepare(
          "SELECT post_id FROM ap_pool_metrics WHERE post_id IN ('old-remote', 'new-remote', 'old-local') ORDER BY post_id",
        )
        .all<{ post_id: string }>();
      assert.deepEqual(
        metrics.results.map((row) => row.post_id),
        ['new-remote', 'old-local'],
      );
    } finally {
      db.close();
    }
  });

  it('refreshes counters, score and fetched_at when the same status is discovered again', async () => {
    const db = createTestDatabase();
    const firstNow = Date.parse(CREATED_AT) + 60 * 60 * 1000;
    const secondNow = firstNow + 60 * 60 * 1000;
    const thirdNow = secondNow + 24 * 60 * 60 * 1000;
    const viral = status({ favourites_count: 100, reblogs_count: 50 });
    let trends: unknown[] = [status()];
    const restore = stubFetch((url) => mastodonFetch(trends)(url));
    try {
      const firstResult = await withNowAsync(firstNow, () => runPoolDiscovery(envFor(db)));
      assert.equal(firstResult.stored, 1);
      assert.equal(firstResult.refreshed, 0);
      const initial = await db
        .prepare('SELECT favourites, reblogs, score, fetched_at FROM ap_pool_metrics')
        .first<{ favourites: number; reblogs: number; score: number; fetched_at: string }>();
      assert.ok(initial);
      assert.equal(initial.favourites, 3);
      assert.equal(initial.reblogs, 2);
      assert.equal(
        initial.score,
        withNow(firstNow, () => computePoolScore({ favourites: 3, reblogs: 2, createdAt: CREATED_AT })),
      );

      trends = [viral];
      const secondResult = await withNowAsync(secondNow, () => runPoolDiscovery(envFor(db)));
      assert.equal(secondResult.stored, 1);
      assert.equal(secondResult.refreshed, 1);
      const refreshed = await db
        .prepare('SELECT favourites, reblogs, score, fetched_at FROM ap_pool_metrics')
        .first<{ favourites: number; reblogs: number; score: number; fetched_at: string }>();
      assert.ok(refreshed);
      assert.equal(refreshed.favourites, 100);
      assert.equal(refreshed.reblogs, 50);
      assert.equal(
        refreshed.score,
        withNow(secondNow, () => computePoolScore({ favourites: 100, reblogs: 50, createdAt: CREATED_AT })),
      );
      assert.notEqual(refreshed.score, initial.score);
      assert.equal(refreshed.fetched_at, new Date(secondNow).toISOString());

      // Same counters, later clock: the stored freshness component must decay.
      const thirdResult = await withNowAsync(thirdNow, () => runPoolDiscovery(envFor(db)));
      assert.equal(thirdResult.stored, 1);
      assert.equal(thirdResult.refreshed, 1);
      const decayed = await db
        .prepare('SELECT score, fetched_at FROM ap_pool_metrics')
        .first<{ score: number; fetched_at: string }>();
      assert.ok(decayed);
      assert.equal(
        decayed.score,
        withNow(thirdNow, () => computePoolScore({ favourites: 100, reblogs: 50, createdAt: CREATED_AT })),
      );
      assert.ok(decayed.score < refreshed.score);
      assert.equal(decayed.fetched_at, new Date(thirdNow).toISOString());

      const posts = await db
        .prepare('SELECT COUNT(*) AS count FROM posts WHERE ap_object_id = ?')
        .bind(OBJECT_ID)
        .first<{ count: number }>();
      assert.equal(posts?.count, 1);
      const metricCount = await db.prepare('SELECT COUNT(*) AS count FROM ap_pool_metrics').first<{ count: number }>();
      assert.equal(metricCount?.count, 1);
    } finally {
      restore();
      db.close();
    }
  });

  it('uses the ActivityPub object id for numeric Mastodon ids so a Delete hides the pooled post', async () => {
    const numericId = '123';
    const apId = `${ACTOR_URL}/statuses/${numericId}`;
    const permalink = `https://${DOMAIN}/@alice/${numericId}`;
    const numeric = status({ id: numericId, url: permalink });
    assert.equal(normalizeMastodonStatus(numeric, actorInfo(), BASE)?.post.ap_object_id, apId);

    const db = createTestDatabase();
    const restore = stubFetch(mastodonFetch([numeric]));
    try {
      const result = await runPoolDiscovery(envFor(db));
      assert.equal(result.stored, 1);
      const pooled = await db
        .prepare('SELECT id, ap_object_id FROM posts WHERE ap_object_id = ?')
        .bind(apId)
        .all<{ id: string; ap_object_id: string }>();
      assert.equal(pooled.results.length, 1);
      assert.equal(pooled.results[0].ap_object_id, apId);
      const byPermalink = await db
        .prepare('SELECT COUNT(*) AS count FROM posts WHERE ap_object_id = ?')
        .bind(permalink)
        .first<{ count: number }>();
      assert.equal(byPermalink?.count, 0);

      await handleIncomingActivity(envFor(db), {
        activity: {
          id: `${ACTOR_URL}/activities/delete-${numericId}`,
          type: 'Delete',
          actor: ACTOR_URL,
          object: { id: apId, type: 'Tombstone' },
        },
        actorId: ACTOR_URL,
        username: 'alice',
      });
      const afterDelete = await db
        .prepare('SELECT status, hidden FROM posts WHERE id = ?')
        .bind(pooled.results[0].id)
        .first<{ status: string; hidden: number }>();
      assert.equal(afterDelete?.status, 'deleted');
      assert.equal(afterDelete?.hidden, 1);
    } finally {
      restore();
      db.close();
    }
  });

  it('prunes only pool-origin rows, keeping inbox posts and their local replies', async () => {
    const db = createTestDatabase();
    const dayMs = 24 * 60 * 60 * 1000;
    try {
      const old = new Date(Date.now() - 30 * dayMs).toISOString();
      // A Note delivered to a follower has no pool metrics and must survive.
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, visibility, created_at)
           VALUES ('inbox-old', '', 'alice@mastodon.test', 'from inbox', 'published', ?, 'public', ?)`,
        )
        .bind(`${ACTOR_URL}/statuses/inbox`, old)
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, parent_id, created_at)
           VALUES ('local-reply', 'u1', 'local', 'reply', 'published', 'inbox-old', ?)`,
        )
        .bind(CREATED_AT)
        .run();
      // A pool-origin post carries metrics; both it and its metrics are pruned.
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
           VALUES ('pool-old', '', 'alice@mastodon.test', 'from pool', 'published', ?, ?)`,
        )
        .bind(`${ACTOR_URL}/statuses/pool`, old)
        .run();
      await db
        .prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, 1, ?)')
        .bind('pool-old', DOMAIN, old)
        .run();

      const removed = await prunePool(envFor(db));
      assert.equal(removed, 2);

      const remaining = await db
        .prepare("SELECT id FROM posts WHERE id IN ('inbox-old', 'local-reply', 'pool-old') ORDER BY id")
        .all<{ id: string }>();
      assert.deepEqual(
        remaining.results.map((row) => row.id),
        ['inbox-old', 'local-reply'],
      );
      const metrics = await db
        .prepare("SELECT post_id FROM ap_pool_metrics WHERE post_id IN ('inbox-old', 'pool-old') ORDER BY post_id")
        .all<{ post_id: string }>();
      assert.deepEqual(metrics.results, []);
    } finally {
      db.close();
    }
  });

  it('detaches local replies before deleting a stale pool post', async () => {
    const db = createTestDatabase();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    try {
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
           VALUES ('pool-parent', '', 'alice@mastodon.test', 'from pool', 'published', ?, ?)`,
        )
        .bind(`${ACTOR_URL}/statuses/parent`, old)
        .run();
      await db
        .prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, 1, ?)')
        .bind('pool-parent', DOMAIN, old)
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, parent_id, root_id, created_at)
           VALUES ('local-child', 'u1', 'local', 'a local reply', 'published', 'pool-parent', 'pool-parent', ?)`,
        )
        .bind(CREATED_AT)
        .run();

      const removed = await prunePool(envFor(db));
      // Orphan metrics + stale metrics + the post itself; the reply is kept.
      assert.equal(removed, 2);
      assert.equal(await db.prepare('SELECT id FROM posts WHERE id = ?').bind('pool-parent').first(), null);
      const reply = await db
        .prepare('SELECT parent_id, root_id FROM posts WHERE id = ?')
        .bind('local-child')
        .first<{ parent_id: string | null; root_id: string | null }>();
      assert.ok(reply, 'the local reply must not be deleted with its remote parent');
      assert.equal(reply.parent_id, null);
      assert.equal(reply.root_id, null);
    } finally {
      db.close();
    }
  });

  it('detaches root-only and quote references before deleting a stale pool post', async () => {
    const db = createTestDatabase();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    try {
      // The regression only bites when SQLite really enforces the plain REFERENCES.
      const fk = await db.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
      assert.equal(fk?.foreign_keys, 1);

      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, created_at)
           VALUES ('surviving-parent', 'u1', 'local', 'parent', 'published', ?)`,
        )
        .bind(CREATED_AT)
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
           VALUES ('pool-parent', '', 'alice@${DOMAIN}', 'from pool', 'published', ?, ?)`,
        )
        .bind(`${ACTOR_URL}/statuses/root`, old)
        .run();
      await db
        .prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, 1, ?)')
        .bind('pool-parent', DOMAIN, old)
        .run();
      // root_id references the stale pool post, while parent_id survives.
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, parent_id, root_id, created_at)
           VALUES ('root-reply', 'u1', 'local', 'reply', 'published', 'surviving-parent', 'pool-parent', ?)`,
        )
        .bind(CREATED_AT)
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, username, text, status, quoted_post_id, created_at)
           VALUES ('local-quote', 'u1', 'local', 'quote', 'published', 'pool-parent', ?)`,
        )
        .bind(CREATED_AT)
        .run();

      const removed = await prunePool(envFor(db));
      assert.equal(removed, 2);
      assert.equal(await db.prepare('SELECT id FROM posts WHERE id = ?').bind('pool-parent').first(), null);
      const reply = await db
        .prepare('SELECT parent_id, root_id FROM posts WHERE id = ?')
        .bind('root-reply')
        .first<{ parent_id: string | null; root_id: string | null }>();
      // The detach clears both self-references on any row that points at the
      // pruned post, including the root-only reply (whose parent survives).
      assert.equal(reply?.parent_id, null);
      assert.equal(reply?.root_id, null);
      const quote = await db
        .prepare('SELECT quoted_post_id FROM posts WHERE id = ?')
        .bind('local-quote')
        .first<{ quoted_post_id: string | null }>();
      assert.equal(quote?.quoted_post_id, null);
    } finally {
      db.close();
    }
  });

  it('keeps a pool post refreshed recently even when the post itself is old', async () => {
    const db = createTestDatabase();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    try {
      for (const [id, fetchedAt] of [
        ['stale-pool', old],
        ['refreshed-pool', fresh],
      ] as const) {
        await db
          .prepare(
            `INSERT INTO posts (id, user_id, username, text, status, ap_object_id, created_at)
             VALUES (?, '', 'alice@mastodon.test', 'from pool', 'published', ?, ?)`,
          )
          .bind(id, `${ACTOR_URL}/statuses/${id}`, old)
          .run();
        await db
          .prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, 1, ?)')
          .bind(id, DOMAIN, fetchedAt)
          .run();
      }

      const removed = await prunePool(envFor(db));
      assert.equal(removed, 2);
      const remaining = await db
        .prepare("SELECT id FROM posts WHERE id IN ('stale-pool', 'refreshed-pool') ORDER BY id")
        .all<{ id: string }>();
      assert.deepEqual(
        remaining.results.map((row) => row.id),
        ['refreshed-pool'],
      );
    } finally {
      db.close();
    }
  });

  it('never exposes unlisted statuses in the public pool', async () => {
    assert.equal(normalizeMastodonStatus(status({ visibility: 'unlisted' }), actorInfo(), BASE), null);
    const db = createTestDatabase();
    const restore = stubFetch(mastodonFetch([status({ visibility: 'unlisted' })]));
    try {
      const result = await runPoolDiscovery(envFor(db));
      assert.deepEqual(result, {
        instances: 1,
        fetched: 1,
        stored: 0,
        inserted: 0,
        refreshed: 0,
        skipped: 1,
        errors: 0,
      });
      const post = await db.prepare('SELECT id FROM posts WHERE ap_object_id = ?').bind(OBJECT_ID).first();
      assert.equal(post, null);
      const metrics = await db.prepare('SELECT post_id FROM ap_pool_metrics').all<{ post_id: string }>();
      assert.deepEqual(metrics.results, []);
    } finally {
      restore();
      db.close();
    }
  });

  it('does not import unlisted Notes from an outbox', async () => {
    const db = createTestDatabase();
    const actor = `https://social.test/users/bob`;
    await db
      .prepare(
        `INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, domain, fetched_at)
         VALUES (?, ?, 'bob', 'social.test', ?)`,
      )
      .bind(actor, `${actor}/inbox`, CREATED_AT)
      .run();
    const restore = stubFetch((url) => {
      if (url === 'https://social.test/.well-known/nodeinfo') {
        return {
          body: {
            links: [
              { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://social.test/nodeinfo/2.1' },
            ],
          },
        };
      }
      if (url === 'https://social.test/nodeinfo/2.1') return { body: { software: { name: 'friendica' } } };
      if (url === actor)
        return { body: { id: actor, type: 'Person', inbox: `${actor}/inbox`, outbox: `${actor}/outbox` } };
      if (url === `${actor}/outbox`) {
        return {
          body: {
            orderedItems: [
              {
                type: 'Create',
                object: {
                  id: `${actor}/notes/1`,
                  type: 'Note',
                  attributedTo: actor,
                  content: '<p>Not for public timelines</p>',
                  published: CREATED_AT,
                  to: [`${actor}/followers`],
                  cc: ['https://www.w3.org/ns/activitystreams#Public'],
                },
              },
            ],
          },
        };
      }
      return null;
    });
    try {
      const result = await runPoolDiscovery(envFor(db, { AP_POOL_SEED_DOMAINS: 'social.test' }));
      assert.deepEqual(result, {
        instances: 1,
        fetched: 1,
        stored: 0,
        inserted: 0,
        refreshed: 0,
        skipped: 1,
        errors: 0,
      });
      const posts = await db
        .prepare('SELECT id FROM posts WHERE ap_object_id = ?')
        .bind(`${actor}/notes/1`)
        .all<{ id: string }>();
      assert.deepEqual(posts.results, []);
    } finally {
      restore();
      db.close();
    }
  });

  it('rejects far-future created_at timestamps', () => {
    const now = Date.parse(CREATED_AT) + 60 * 60 * 1000;
    const future = new Date(now + 60 * 60 * 1000).toISOString();
    assert.equal(
      withNow(now, () => normalizeMastodonStatus(status({ created_at: future }), actorInfo(), BASE)),
      null,
    );
    // Normal clock drift within a few minutes is tolerated.
    const slightlyAhead = new Date(now + 2 * 60 * 1000).toISOString();
    assert.ok(withNow(now, () => normalizeMastodonStatus(status({ created_at: slightlyAhead }), actorInfo(), BASE)));
    assert.equal(normalizeMastodonStatus(status({ created_at: 'not-a-date' }), actorInfo(), BASE), null);
  });
});
