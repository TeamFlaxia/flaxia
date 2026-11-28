import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  type HandlerEnv,
  handleIncomingActivity,
  visibilityFromInboundAudience,
} from '../functions/lib/activitypub/handlers.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

const BASE = 'https://flaxia.app';
const SOURCE = 'https://old.example/users/alice';
const TARGET = 'https://new.example/users/alice';
const NEW_INSTANCE = 'https://other.example/users/alice';

let db: TestDatabase;

beforeEach(() => {
  db = createTestDatabase();
});

function envFor(): HandlerEnv {
  return { DB: db as unknown as HandlerEnv['DB'], BASE_URL: BASE };
}

function seedSourceActor(): void {
  db.prepare(
    `INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, display_name, domain)
     VALUES (?, ?, 'alice', 'Alice', 'old.example')`,
  )
    .bind(SOURCE, `${SOURCE}/inbox`)
    .run();
}

async function movedTo(): Promise<string | null> {
  const row = await db
    .prepare('SELECT moved_to FROM ap_actors WHERE actor_url = ?')
    .bind(SOURCE)
    .first<{ moved_to: string | null }>();
  return row?.moved_to ?? null;
}

/** Serve target actor documents; `null` means an unrelated actor document. */
function stubTargets(targets: Record<string, Record<string, unknown> | null>): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!(url in targets)) return new Response('not found', { status: 404 });
    const document = targets[url];
    if (document === null) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ id: url, type: 'Person', ...document }), {
      status: 200,
      headers: { 'Content-Type': 'application/activity+json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function deliverMove(id: string, target: string): Promise<void> {
  await handleIncomingActivity(envFor(), {
    actorId: SOURCE,
    username: 'alice',
    activity: {
      id: `https://old.example/activities/${id}`,
      type: 'Move',
      actor: SOURCE,
      object: SOURCE,
      target,
    },
  });
}

describe('PR 512 handler fixes', () => {
  it('defaults a Note without any audience to direct instead of public', () => {
    assert.equal(visibilityFromInboundAudience({}, {}, SOURCE), 'direct');
    // Hidden addresses resolve mentions but never widen visibility.
    assert.equal(visibilityFromInboundAudience({ bto: ['https://flaxia.app/users/bob'] }, {}, SOURCE), 'direct');
    assert.equal(visibilityFromInboundAudience({}, { audience: ['https://flaxia.app/users/bob'] }, SOURCE), 'direct');
    // Explicit audiences keep their existing mapping.
    assert.equal(
      visibilityFromInboundAudience({ to: ['https://www.w3.org/ns/activitystreams#Public'] }, {}, SOURCE),
      'public',
    );
    assert.equal(visibilityFromInboundAudience({ to: [`${SOURCE}/followers`] }, {}, SOURCE), 'private');
  });

  it('stores a Note with no audience as a direct post', async () => {
    await seedLocalUser(db, { id: 'local-1', username: 'alice' });
    db.prepare(
      `INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, status, created_at)
       VALUES ('following-no-audience', 'local-1', ?, ?, 'accepted', '2026-01-01T00:00:00.000Z')`,
    )
      .bind(SOURCE, `${SOURCE}/inbox`)
      .run();
    const objectId = `${SOURCE}/notes/no-audience`;
    await handleIncomingActivity(envFor(), {
      actorId: SOURCE,
      username: 'alice',
      activity: {
        id: `${SOURCE}/activities/no-audience`,
        type: 'Create',
        actor: SOURCE,
        object: { id: objectId, type: 'Note', attributedTo: SOURCE, content: 'quiet words' },
      },
    });
    const post = await db
      .prepare('SELECT visibility FROM posts WHERE ap_object_id = ?')
      .bind(objectId)
      .first<{ visibility: string }>();
    assert.equal(post?.visibility, 'direct');
  });

  it('accepts a cross-instance Move whose target back-references the source', async () => {
    seedSourceActor();
    const restore = stubTargets({ [TARGET]: { movedFrom: SOURCE } });
    try {
      await deliverMove('cross-instance-accepted', TARGET);
    } finally {
      restore();
    }
    assert.equal(await movedTo(), TARGET);
  });

  it('accepts a cross-instance Move with an alsoKnownAs back-reference', async () => {
    seedSourceActor();
    const restore = stubTargets({
      [NEW_INSTANCE]: { alsoKnownAs: [`${SOURCE}/`, 'https://elsewhere.example/u/alice'] },
    });
    try {
      await deliverMove('cross-instance-alias', NEW_INSTANCE);
    } finally {
      restore();
    }
    assert.equal(await movedTo(), NEW_INSTANCE);
  });

  it('rejects a cross-instance Move whose target has no back-reference', async () => {
    seedSourceActor();
    const restore = stubTargets({ [TARGET]: { movedFrom: 'https://old.example/users/bob' } });
    try {
      await deliverMove('cross-instance-rejected', TARGET);
    } finally {
      restore();
    }
    assert.equal(await movedTo(), null, 'an actor that does not acknowledge the source is not a valid move target');
  });

  it('rejects a cross-instance Move whose document is not the target actor', async () => {
    seedSourceActor();
    const restore = stubTargets({ [TARGET]: { id: 'https://new.example/users/someone-else', movedFrom: SOURCE } });
    try {
      await deliverMove('cross-instance-wrong-id', TARGET);
    } finally {
      restore();
    }
    assert.equal(await movedTo(), null);
  });
});
