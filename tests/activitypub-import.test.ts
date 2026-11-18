import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { importRemoteOutbox } from '../functions/lib/activitypub/import.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const ACTOR = `${REMOTE}/users/bob`;
const OUTBOX = `${ACTOR}/outbox`;
const PAGE = `${OUTBOX}?page=true`;
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/activity+json' } });
}

function create(id: string, content: string, to: string[]): Record<string, unknown> {
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
    },
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

  it('imports public top-level Notes once and skips non-public ones', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === ACTOR) {
        return json({
          id: ACTOR,
          type: 'Person',
          preferredUsername: 'bob',
          name: 'Bob',
          outbox: OUTBOX,
        });
      }
      if (url === OUTBOX) {
        return json({ id: OUTBOX, type: 'OrderedCollection', totalItems: 2, first: PAGE });
      }
      if (url === PAGE) {
        return json({
          id: PAGE,
          type: 'OrderedCollectionPage',
          partOf: OUTBOX,
          orderedItems: [
            create(`${REMOTE}/notes/1`, '<p>hello #flaxia</p>', [PUBLIC]),
            create(`${REMOTE}/notes/2`, '<p>followers only</p>', [ACTOR]),
          ],
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      const env = { DB: db as unknown as D1Database, BASE_URL: BASE };
      const first = await importRemoteOutbox(env, { actorUrl: ACTOR, username: 'alice', limit: 10 });
      assert.equal(first.scanned, 2);
      assert.equal(first.imported, 1);
      assert.equal(first.skipped, 1);

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

      const second = await importRemoteOutbox(env, { actorUrl: ACTOR, username: 'alice', limit: 10 });
      assert.equal(second.imported, 0);
      assert.equal(second.skipped, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
