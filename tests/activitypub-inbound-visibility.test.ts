import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import { PUBLIC_COLLECTION } from '../functions/lib/activitypub/context.ts';
import { exportPrivateKey, exportPublicKey, generateKeyPair } from '../functions/lib/activitypub/crypto.ts';
import { type HandlerEnv, handleIncomingActivity } from '../functions/lib/activitypub/handlers.ts';
import { type InboxEnv, verifyIncomingActivity } from '../functions/lib/activitypub/inbox.ts';
import { signRequest } from '../functions/lib/activitypub/signature.ts';
import type { User } from '../functions/lib/auth.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// The shared test adapter's `all()` has no `success` flag, while the route
// handlers check it exactly like real D1. Add it locally so the real read path
// can run against the in-memory database (same pattern as post-visibility.test.ts).
type TestStatement = ReturnType<TestDatabase['prepare']>;

function wrapStatement(statement: TestStatement): TestStatement {
  return {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
    first: <T>() => statement.first<T>(),
    all: async <T>() =>
      ({ ...(await statement.all<T>()), success: true }) as Awaited<ReturnType<TestStatement['all']>> & T,
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

// Route modules use extensionless relative imports for the Worker bundler;
// Node needs a resolver shim to load the same modules for behavioural tests.
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

const { manage } = await import('../functions/api/routes/posts/manage.ts');

type AppEnv = { Bindings: Bindings; Variables: Variables };

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const REMOTE_ACTOR = `${REMOTE}/users/alice`;
const FOLLOWERS = `${REMOTE_ACTOR}/followers`;
const NOW = '2026-11-26T00:00:00.000Z';

function user(id: string, username: string, displayName: string): User {
  return { id, email: `${id}@test.com`, username, display_name: displayName, bio: '', created_at: NOW };
}

const ALICE = user('alice', 'alice', 'Alice'); // follows the remote actor
const BOB = user('bob', 'bob', 'Bob');
const CAROL = user('carol', 'carol', 'Carol'); // follows nobody

const databases: TestDatabase[] = [];
let db: TestDatabase;
let privateKeyPem: string;
let publicKeyPem: string;
let originalFetch: typeof fetch;

beforeEach(async () => {
  db = createTestDatabase();
  databases.push(db);
  db.prepare('DELETE FROM posts').run();
  for (const viewer of [ALICE, BOB, CAROL]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', ?)`,
    )
      .bind(viewer.id, viewer.email, viewer.username, viewer.display_name, NOW)
      .run();
  }
  // Alice follows the remote actor; Bob and Carol do not. This is what makes
  // handleCreate accept the delivery in the first place.
  db.prepare(
    `INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, status, created_at)
     VALUES ('following-remote', ?, ?, ?, 'accepted', ?)`,
  )
    .bind(ALICE.id, REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, NOW)
    .run();
  db.prepare(
    `INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, display_name, domain, fetched_at)
     VALUES (?, ?, 'alice', 'Alice Remote', 'remote.example', ?)`,
  )
    .bind(REMOTE_ACTOR, `${REMOTE_ACTOR}/inbox`, NOW)
    .run();

  const pair = await generateKeyPair();
  privateKeyPem = await exportPrivateKey(pair.privateKey);
  publicKeyPem = await exportPublicKey(pair.publicKey);

  // Serve the signing actor's real key so the delivery passes the same HTTP
  // signature verification the production inbox applies.
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).startsWith(REMOTE)) return new Response('not found', { status: 404 });
    return new Response(
      JSON.stringify({
        id: REMOTE_ACTOR,
        type: 'Person',
        preferredUsername: 'alice',
        name: 'Alice Remote',
        inbox: `${REMOTE_ACTOR}/inbox`,
        publicKey: { id: `${REMOTE_ACTOR}#main-key`, owner: REMOTE_ACTOR, publicKeyPem },
      }),
      { headers: { 'Content-Type': 'application/activity+json' } },
    );
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const database of databases) database.close();
});

function routeEnv(): Bindings {
  return { DB: wrapDb(db) as unknown as Bindings['DB'] } as Bindings;
}

function handlerEnv(): HandlerEnv {
  return { DB: wrapDb(db) as unknown as HandlerEnv['DB'], BASE_URL: BASE };
}

function inboxEnv(): InboxEnv {
  return { DB: wrapDb(db) as unknown as InboxEnv['DB'], BASE_URL: BASE };
}

/** Feed a signed Create through the real inbox verification pipeline. */
async function deliverCreate(options: {
  id: string;
  to: string[];
  cc?: string[];
  /** Some peers only carry the audience on the Note, not on the Create. */
  audienceOnObjectOnly?: boolean;
  username?: string;
}): Promise<string> {
  const username = options.username ?? 'alice';
  const objectId = `${REMOTE}/notes/${options.id}`;
  const activity: Record<string, unknown> = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${REMOTE}/activities/${options.id}`,
    type: 'Create',
    actor: REMOTE_ACTOR,
    object: {
      id: objectId,
      type: 'Note',
      attributedTo: REMOTE_ACTOR,
      content: `<p>${options.id}</p>`,
      to: options.to,
      cc: options.cc ?? [],
    },
  };
  if (!options.audienceOnObjectOnly) {
    activity.to = options.to;
    activity.cc = options.cc ?? [];
  }
  const body = JSON.stringify(activity);
  const inboxUrl = `${BASE}/api/actors/${username}/inbox`;
  const headers = await signRequest(inboxUrl, body, privateKeyPem, `${REMOTE_ACTOR}#main-key`);
  const request = new Request(inboxUrl, { method: 'POST', headers, body });
  const verified = await verifyIncomingActivity(inboxEnv(), request, body);
  assert.equal(verified.ok, true, verified.ok ? '' : `signature/digest rejected: ${verified.error}`);
  await handleIncomingActivity(handlerEnv(), {
    activity: verified.activity,
    actorId: verified.actorId,
    username,
  });
  return objectId;
}

async function storedPost(objectId: string): Promise<{
  id: string;
  visibility: string;
  mentions: string;
  actor_id: string;
} | null> {
  return db
    .prepare('SELECT id, visibility, mentions, actor_id FROM posts WHERE ap_object_id = ?')
    .bind(objectId)
    .first<{ id: string; visibility: string; mentions: string; actor_id: string }>();
}

function routeApp(viewer: User | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (viewer) c.set('user', viewer);
    await next();
  });
  app.route('/', manage);
  return app;
}

async function readPost(postId: string, viewer: User | null): Promise<Response> {
  return routeApp(viewer).request(`http://localhost/posts/${postId}`, {}, routeEnv());
}

function localActor(username: string): string {
  return `${BASE}/api/actors/${username}`;
}

describe('ActivityPub inbound audience → stored visibility', () => {
  it('stores a Create addressed to the Public collection as public', async () => {
    const objectId = await deliverCreate({ id: 'inbound-public', to: [PUBLIC_COLLECTION], cc: [FOLLOWERS] });
    const post = await storedPost(objectId);
    assert.ok(post, 'the Note must be stored');
    assert.equal(post.actor_id, REMOTE_ACTOR);
    assert.equal(post.visibility, 'public');

    assert.equal((await readPost(post.id, null)).status, 200, 'a stranger reads a public Note');
    assert.equal((await readPost(post.id, BOB)).status, 200, 'an unrelated local user reads a public Note');
  });

  it('stores a Create addressed only to one local actor as direct, readable only by that user', async () => {
    const objectId = await deliverCreate({ id: 'inbound-direct', to: [localActor('bob')], cc: [] });
    const post = await storedPost(objectId);
    assert.ok(post, 'the Note must be stored');
    assert.equal(post.visibility, 'direct', 'a private address must not become a public post');
    assert.deepEqual(JSON.parse(post.mentions), [{ username: 'bob', user_id: BOB.id }]);

    assert.equal((await readPost(post.id, null)).status, 404, 'an anonymous visitor must not see a direct Note');
    assert.equal((await readPost(post.id, CAROL)).status, 404, 'an unmentioned user must not see a direct Note');
    assert.equal((await readPost(post.id, BOB)).status, 200, 'the addressed user must see the direct Note');
  });

  it('resolves a direct addressee carried only on the Note object', async () => {
    const objectId = await deliverCreate({
      id: 'inbound-direct-object-only',
      to: [localActor('bob')],
      audienceOnObjectOnly: true,
    });
    const post = await storedPost(objectId);
    assert.ok(post);
    assert.equal(post.visibility, 'direct');
    assert.deepEqual(JSON.parse(post.mentions), [{ username: 'bob', user_id: BOB.id }]);
    assert.equal((await readPost(post.id, null)).status, 404);
    assert.equal((await readPost(post.id, BOB)).status, 200);
  });

  it('stores a followers-only Create as private, hidden from strangers and non-followers', async () => {
    const objectId = await deliverCreate({ id: 'inbound-followers', to: [FOLLOWERS], cc: [] });
    const post = await storedPost(objectId);
    assert.ok(post, 'the Note must be stored');
    assert.equal(post.visibility, 'private', 'followers-only is not public');

    assert.equal(
      (await readPost(post.id, null)).status,
      404,
      'an anonymous visitor must not see a followers-only Note',
    );
    assert.equal((await readPost(post.id, BOB)).status, 404, 'a non-follower must not see a followers-only Note');
    assert.equal((await readPost(post.id, ALICE)).status, 200, 'the local follower must see the Note');
  });

  it('stores a Create with Public only in cc as unlisted', async () => {
    const objectId = await deliverCreate({ id: 'inbound-unlisted', to: [FOLLOWERS], cc: [PUBLIC_COLLECTION] });
    const post = await storedPost(objectId);
    assert.ok(post);
    assert.equal(post.visibility, 'unlisted');
    assert.equal((await readPost(post.id, null)).status, 200, 'unlisted stays readable by everyone');
  });
});
