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

/** `freshnessBoost` reads `Date.now()`; pin it so score assertions are deterministic. */
function withFixedNow<T>(fn: () => T): T {
  const original = Date.now;
  const now = Date.parse(CREATED_AT) + 60 * 60 * 1000;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
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
function mastodonFetch(trends: unknown[]): (url: string) => { status?: number; body: unknown } | null {
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
    if (url.startsWith(`https://${DOMAIN}/api/v1/trends/statuses`)) return { body: trends };
    return null;
  };
}

describe('federated popularity pool', () => {
  it('uses the agreed freshness-boosted score formula', () =>
    withFixedNow(() => {
      const params = {
        favourites: 4,
        reblogs: 9,
        createdAt: CREATED_AT,
        flaxiaFresh: 2,
        flaxiaReload: 3,
      };
      const expected =
        1.0 * Math.log1p(4) + 2.0 * Math.log1p(9) + 1.5 * freshnessBoost(CREATED_AT) + 2.0 * Math.log1p(5);
      assert.equal(computePoolScore(params), expected);
      assert.equal(
        computePoolScore({ ...params, favourites: 0, reblogs: 0, flaxiaFresh: 0, flaxiaReload: 0 }),
        1.5 * freshnessBoost(CREATED_AT),
      );
      // Bad counters must not poison the ranking with NaN.
      assert.ok(Number.isFinite(computePoolScore({ ...params, favourites: Number.NaN })));
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
      assert.equal(
        result.metrics.score,
        computePoolScore({
          favourites: 3,
          reblogs: 2,
          createdAt: CREATED_AT,
          flaxiaFresh: 0,
          flaxiaReload: 0,
        }),
      );
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
    assert.ok(normalizeMastodonStatus(status({ visibility: 'unlisted' }), actorInfo(), BASE));

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
      assert.deepEqual(result, { instances: 1, fetched: 3, stored: 1, skipped: 2, errors: 0 });

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
      assert.deepEqual(result, { instances: 1, fetched: 1, stored: 1, skipped: 0, errors: 0 });
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

  it('respects the total cap across instances', async () => {
    const db = createTestDatabase();
    const restore = stubFetch(mastodonFetch([status(), status({ id: `${ACTOR_URL}/statuses/2` })]));
    try {
      const result = await runPoolDiscovery(envFor(db), { maxTotal: 1, maxPostsPerInstance: 40 });
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
});
