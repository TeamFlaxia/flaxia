import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { importRemoteOutbox } from '../functions/lib/activitypub/import.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const ACTOR = `${REMOTE}/users/bob`;
const OUTBOX = `${ACTOR}/outbox`;
const PAGE = `${OUTBOX}?page=true`;
const PAGE2 = `${OUTBOX}?page=true&min_id=2`;
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/activity+json' } });
}

function actorDocument(): Record<string, unknown> {
  return {
    id: ACTOR,
    type: 'Person',
    preferredUsername: 'bob',
    name: 'Bob',
    inbox: `${ACTOR}/inbox`,
    outbox: OUTBOX,
  };
}

function create(
  id: string,
  content: string,
  to: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `${id}/activity`,
    type: 'Create',
    actor: ACTOR,
    object: {
      id,
      type: 'Note',
      attributedTo: ACTOR,
      content,
      published: '2026-11-17T12:00:00.000Z',
      to,
      cc: [],
      ...overrides,
    },
  };
}

function installFetch(routes: Record<string, () => Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = routes[url];
    return handler ? handler() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('ActivityPub outbox import', () => {
  let db: TestDatabase;

  before(async () => {
    db = createTestDatabase();
    await seedLocalUser(db, { id: 'local-1', username: 'alice', displayName: 'Alice' });
  });

  after(() => {
    db.close();
  });

  it('imports public top-level Notes once, caches the actor and skips non-public ones', async () => {
    const restore = installFetch({
      [ACTOR]: () => json(actorDocument()),
      [OUTBOX]: () => json({ id: OUTBOX, type: 'OrderedCollection', totalItems: 2, first: PAGE }),
      [PAGE]: () =>
        json({
          id: PAGE,
          type: 'OrderedCollectionPage',
          partOf: OUTBOX,
          orderedItems: [
            create(`${REMOTE}/notes/1`, '<p>hello #flaxia</p>', [PUBLIC]),
            create(`${REMOTE}/notes/2`, '<p>followers only</p>', [ACTOR]),
          ],
        }),
    });

    try {
      const env = { DB: db as unknown as D1Database, BASE_URL: BASE };
      const first = await importRemoteOutbox(env, { actorUrl: ACTOR, username: 'alice', limit: 10 });
      assert.equal(first.scanned, 2);
      assert.equal(first.imported, 1);
      assert.equal(first.skipped, 1);
      assert.equal(first.truncated, false);

      const row = await db
        .prepare('SELECT user_id, username, actor_id, ap_object_id, text, hashtags FROM posts WHERE ap_object_id = ?')
        .bind(`${REMOTE}/notes/1`)
        .first<{
          user_id: string;
          username: string;
          actor_id: string;
          ap_object_id: string;
          text: string;
          hashtags: string;
        }>();
      assert.ok(row);
      assert.equal(row.user_id, '');
      assert.equal(row.username, 'bob@remote.example');
      assert.equal(row.actor_id, ACTOR);
      assert.equal(row.text, 'hello #flaxia');
      assert.deepEqual(JSON.parse(row.hashtags), ['flaxia']);

      const actor = await db
        .prepare('SELECT display_name, preferred_username, domain FROM ap_actors WHERE actor_url = ?')
        .bind(ACTOR)
        .first<{ display_name: string; preferred_username: string; domain: string }>();
      assert.equal(actor?.display_name, 'Bob');
      assert.equal(actor?.preferred_username, 'bob');
      assert.equal(actor?.domain, 'remote.example');

      const second = await importRemoteOutbox(env, { actorUrl: ACTOR, username: 'alice', limit: 10 });
      assert.equal(second.imported, 0);
      assert.equal(second.skipped, 2);
    } finally {
      restore();
    }
  });

  it('reads an inlined first page and follows the next page', async () => {
    const restore = installFetch({
      [ACTOR]: () => json(actorDocument()),
      [OUTBOX]: () =>
        json({
          id: OUTBOX,
          type: 'OrderedCollection',
          first: {
            id: PAGE,
            type: 'OrderedCollectionPage',
            partOf: OUTBOX,
            orderedItems: [create(`${REMOTE}/notes/inline`, '<p>inline page</p>', [PUBLIC])],
            next: PAGE2,
          },
        }),
      [PAGE2]: () =>
        json({
          id: PAGE2,
          type: 'OrderedCollectionPage',
          partOf: OUTBOX,
          orderedItems: [create(`${REMOTE}/notes/next`, '<p>next page</p>', [PUBLIC])],
        }),
    });

    try {
      const result = await importRemoteOutbox(
        { DB: db as unknown as D1Database, BASE_URL: BASE },
        { actorUrl: ACTOR, username: 'alice', limit: 10 },
      );
      assert.equal(result.pages, 2);
      assert.equal(result.imported, 2);
      assert.equal(result.truncated, false);
      const count = await db
        .prepare('SELECT COUNT(*) AS n FROM posts WHERE ap_object_id IN (?, ?)')
        .bind(`${REMOTE}/notes/inline`, `${REMOTE}/notes/next`)
        .first<{ n: number }>();
      assert.equal(count?.n, 2);
    } finally {
      restore();
    }
  });

  it('skips replies, boosts and foreign origins, accepts attributedTo arrays and clamps future dates', async () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const restore = installFetch({
      [ACTOR]: () => json(actorDocument()),
      [OUTBOX]: () =>
        json({
          id: OUTBOX,
          type: 'OrderedCollection',
          first: {
            id: PAGE,
            type: 'OrderedCollectionPage',
            orderedItems: [
              create(`${REMOTE}/notes/reply`, '<p>reply</p>', [PUBLIC], { inReplyTo: `${REMOTE}/notes/root` }),
              {
                id: `${REMOTE}/notes/boost/activity`,
                type: 'Announce',
                actor: ACTOR,
                object: create(`${REMOTE}/notes/boosted`, '<p>boosted</p>', [PUBLIC]).object,
              },
              create(`${REMOTE}/notes/foreign`, '<p>foreign</p>', [PUBLIC], {
                id: 'https://other.example/notes/1',
              }),
              create(`${REMOTE}/notes/array`, '<p>array author</p>', [PUBLIC], {
                attributedTo: [ACTOR],
                published: future,
              }),
            ],
            next: 'https://other.example/next',
          },
        }),
    });

    try {
      const result = await importRemoteOutbox(
        { DB: db as unknown as D1Database, BASE_URL: BASE },
        { actorUrl: ACTOR, username: 'alice', limit: 10 },
      );
      assert.equal(result.imported, 1);
      // Replies and foreign origins are skipped; an Announce is not a Note
      // candidate and is not counted in `scanned`/`skipped`.
      assert.equal(result.skipped, 2);
      assert.equal(result.truncated, true, 'a next page on another origin must not be fetched');

      const row = await db
        .prepare('SELECT created_at FROM posts WHERE ap_object_id = ?')
        .bind(`${REMOTE}/notes/array`)
        .first<{ created_at: string }>();
      assert.ok(row);
      assert.ok(Date.parse(row.created_at) <= Date.now() + 1000, 'future published dates are clamped to now');
    } finally {
      restore();
    }
  });

  it('stops at the requested note limit', async () => {
    const notes = Array.from({ length: 5 }, (_, index) =>
      create(`${REMOTE}/notes/limit-${index}`, `<p>note ${index}</p>`, [PUBLIC]),
    );
    const restore = installFetch({
      [ACTOR]: () => json(actorDocument()),
      [OUTBOX]: () => json({ id: OUTBOX, type: 'OrderedCollection', first: PAGE }),
      [PAGE]: () => json({ id: PAGE, type: 'OrderedCollectionPage', orderedItems: notes }),
    });

    try {
      const result = await importRemoteOutbox(
        { DB: db as unknown as D1Database, BASE_URL: BASE },
        { actorUrl: ACTOR, username: 'alice', limit: 3 },
      );
      assert.equal(result.scanned, 3);
      assert.equal(result.imported, 3);
    } finally {
      restore();
    }
  });
});
