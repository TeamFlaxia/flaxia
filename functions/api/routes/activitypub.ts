import { Hono } from 'hono';
import { actorCollectionUrls, actorUrl, buildActorDocument, noteUrl } from '../../lib/activitypub/actor.ts';
import { AS2_CONTEXT, activityContentType } from '../../lib/activitypub/context.ts';
import { exportPrivateKey, exportPublicKey, generateKeyPair } from '../../lib/activitypub/crypto';
import { handlePersonalInbox, handleSharedInbox } from '../../lib/activitypub/inbox';
import { buildCreateActivity, buildNoteObject } from '../../lib/activitypub/note';
import { webfingerResponse } from '../../lib/activitypub/webfinger';
import type { Bindings, Variables } from '../types';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const COLLECTION_PAGE_SIZE = 20;

function jsonLd(contentType: string, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

/** The actor key of a local account, created on first use. */
async function ensureActorKey(db: Bindings['DB'], userId: string): Promise<string> {
  const keyRecord = await db
    .prepare('SELECT public_key_pem FROM actor_keys WHERE user_id = ?')
    .bind(userId)
    .first<{ public_key_pem: string }>();
  if (keyRecord?.public_key_pem) return keyRecord.public_key_pem;

  const keyPair = await generateKeyPair();
  const generatedPublicKey = await exportPublicKey(keyPair.publicKey);
  // Concurrent GETs must never replace an already published actor key.
  await db
    .prepare(
      `INSERT OR IGNORE INTO actor_keys (user_id, public_key_pem, private_key_pem, created_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(userId, generatedPublicKey, await exportPrivateKey(keyPair.privateKey))
    .run();
  const stored = await db
    .prepare('SELECT public_key_pem FROM actor_keys WHERE user_id = ?')
    .bind(userId)
    .first<{ public_key_pem: string }>();
  if (!stored) throw new Error('Actor key could not be initialized');
  return stored.public_key_pem;
}

interface LocalActorUser {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_key: string | null;
  created_at: string | null;
}

async function findActor(db: Bindings['DB'], username: string): Promise<LocalActorUser | null> {
  return db
    .prepare(
      `SELECT id, username, display_name, bio, avatar_key, created_at FROM users
       WHERE username = ? COLLATE NOCASE AND frozen_at IS NULL`,
    )
    .bind(username)
    .first<LocalActorUser>();
}

// GET /.well-known/webfinger - WebFinger endpoint for ActivityPub discovery
app.get('/.well-known/webfinger', async (c) => {
  const result = await webfingerResponse(c.env, c.req.query('resource'));
  return c.json(result.body, result.status as 200, result.contentType ? { 'Content-Type': result.contentType } : {});
});

// GET /host-meta - LRDD host meta, points at the WebFinger endpoint
app.get('/host-meta', (c) => {
  const base = new URL(c.env.BASE_URL);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" template="${base.origin}/.well-known/webfinger?resource={uri}"/>
</XRD>`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xrd+xml' } });
});

// GET /api/actors/:username - ActivityPub Actor (Person) endpoint
app.get('/api/actors/:username', async (c) => {
  const username = c.req.param('username');
  const user = await findActor(c.env.DB, username);
  if (!user) return c.json({ error: 'User not found' }, 404);

  const publicKeyPem = await ensureActorKey(c.env.DB, user.id);
  const document = buildActorDocument({
    baseUrl: c.env.BASE_URL,
    user,
    publicKeyPem,
  });

  return jsonLd(activityContentType(c.req.header('accept')), document);
});

// POST /api/actors/:username/inbox - ActivityPub inbox endpoint
app.post('/api/actors/:username/inbox', async (c) => {
  return handlePersonalInbox(c.env, c.req.raw, c.req.param('username'));
});

// POST /api/inbox - ActivityPub sharedInbox endpoint
app.post('/api/inbox', async (c) => {
  return handleSharedInbox(c.env, c.req.raw);
});

/** Build the JSON-LD document of a collection. */
function collection(input: {
  id: string;
  type: 'OrderedCollection' | 'OrderedCollectionPage';
  totalItems: number;
  items?: string[];
  partOf?: string;
  next?: string;
  prev?: string;
}): Record<string, unknown> {
  const document: Record<string, unknown> = {
    '@context': AS2_CONTEXT,
    id: input.id,
    type: input.type,
    totalItems: input.totalItems,
  };
  if (input.items) document.orderedItems = input.items;
  if (input.partOf) document.partOf = input.partOf;
  if (input.next) document.next = input.next;
  if (input.prev) document.prev = input.prev;
  return document;
}

function pageNumber(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

// GET /api/actors/:username/followers - ActivityPub Followers collection
app.get('/api/actors/:username/followers', async (c) => {
  const username = c.req.param('username');
  const user = await findActor(c.env.DB, username);
  if (!user) return c.json({ error: 'User not found' }, 404);

  const localCount =
    (
      await c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?')
        .bind(user.id)
        .first<{ count: number }>()
    )?.count ?? 0;
  const remoteCount =
    (
      await c.env.DB.prepare('SELECT COUNT(*) as count FROM ap_followers WHERE local_user_id = ?')
        .bind(user.id)
        .first<{ count: number }>()
    )?.count ?? 0;
  const totalItems = localCount + remoteCount;
  const collections = actorCollectionUrls(c.env.BASE_URL, username);
  const page = c.req.query('page');

  if (!page) {
    return jsonLd(
      activityContentType(c.req.header('accept')),
      collection({
        id: collections.followers,
        type: 'OrderedCollection',
        totalItems,
      }),
    );
  }

  const current = pageNumber(page);
  const offset = (current - 1) * COLLECTION_PAGE_SIZE;
  const localFollowers = await c.env.DB.prepare(
    `SELECT u.username FROM follows f JOIN users u ON u.id = f.follower_id
     WHERE f.followee_id = ? ORDER BY u.username ASC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, COLLECTION_PAGE_SIZE, offset)
    .all<{ username: string }>();

  const remoteFollowers = await c.env.DB.prepare(
    `SELECT actor_url FROM ap_followers WHERE local_user_id = ?
     ORDER BY actor_url ASC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, COLLECTION_PAGE_SIZE, Math.max(0, offset - localCount))
    .all<{ actor_url: string }>();

  const items = [
    ...(localFollowers.results ?? []).map((row) => actorUrl(c.env.BASE_URL, row.username)),
    ...(remoteFollowers.results ?? []).map((row) => row.actor_url),
  ];

  return jsonLd(
    activityContentType(c.req.header('accept')),
    collection({
      id: `${collections.followers}?page=${current}`,
      type: 'OrderedCollectionPage',
      totalItems,
      items,
      partOf: collections.followers,
      next: offset + COLLECTION_PAGE_SIZE < totalItems ? `${collections.followers}?page=${current + 1}` : undefined,
      prev: current > 1 ? `${collections.followers}?page=${current - 1}` : undefined,
    }),
  );
});

// GET /api/actors/:username/following - ActivityPub Following collection
app.get('/api/actors/:username/following', async (c) => {
  const username = c.req.param('username');
  const user = await findActor(c.env.DB, username);
  if (!user) return c.json({ error: 'User not found' }, 404);

  const localCount =
    (
      await c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?')
        .bind(user.id)
        .first<{ count: number }>()
    )?.count ?? 0;
  const remoteCount =
    (
      await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM ap_following WHERE local_user_id = ? AND status = 'accepted'`,
      )
        .bind(user.id)
        .first<{ count: number }>()
    )?.count ?? 0;
  const totalItems = localCount + remoteCount;
  const collections = actorCollectionUrls(c.env.BASE_URL, username);
  const page = c.req.query('page');

  if (!page) {
    return jsonLd(
      activityContentType(c.req.header('accept')),
      collection({ id: collections.following, type: 'OrderedCollection', totalItems }),
    );
  }

  const current = pageNumber(page);
  const offset = (current - 1) * COLLECTION_PAGE_SIZE;
  const localFollowing = await c.env.DB.prepare(
    `SELECT u.username FROM follows f JOIN users u ON u.id = f.followee_id
     WHERE f.follower_id = ? ORDER BY u.username ASC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, COLLECTION_PAGE_SIZE, offset)
    .all<{ username: string }>();
  const remoteFollowing = await c.env.DB.prepare(
    `SELECT target_actor_url FROM ap_following WHERE local_user_id = ? AND status = 'accepted'
     ORDER BY target_actor_url ASC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, COLLECTION_PAGE_SIZE, Math.max(0, offset - localCount))
    .all<{ target_actor_url: string }>();

  const items = [
    ...(localFollowing.results ?? []).map((row) => actorUrl(c.env.BASE_URL, row.username)),
    ...(remoteFollowing.results ?? []).map((row) => row.target_actor_url),
  ];

  return jsonLd(
    activityContentType(c.req.header('accept')),
    collection({
      id: `${collections.following}?page=${current}`,
      type: 'OrderedCollectionPage',
      totalItems,
      items,
      partOf: collections.following,
      next: offset + COLLECTION_PAGE_SIZE < totalItems ? `${collections.following}?page=${current + 1}` : undefined,
      prev: current > 1 ? `${collections.following}?page=${current - 1}` : undefined,
    }),
  );
});

// GET /api/actors/:username/liked - ActivityPub Liked collection
app.get('/api/actors/:username/liked', async (c) => {
  const username = c.req.param('username');
  const user = await findActor(c.env.DB, username);
  if (!user) return c.json({ error: 'User not found' }, 404);

  const collections = actorCollectionUrls(c.env.BASE_URL, username);
  const totalItems =
    (
      await c.env.DB.prepare('SELECT COUNT(*) as count FROM likes WHERE user_id = ?')
        .bind(user.id)
        .first<{ count: number }>()
    )?.count ?? 0;

  const page = c.req.query('page');
  if (!page) {
    return jsonLd(
      activityContentType(c.req.header('accept')),
      collection({ id: collections.liked, type: 'OrderedCollection', totalItems }),
    );
  }

  const current = pageNumber(page);
  const offset = (current - 1) * COLLECTION_PAGE_SIZE;
  const likes = await c.env.DB.prepare(
    'SELECT post_id FROM likes WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
  )
    .bind(user.id, COLLECTION_PAGE_SIZE, offset)
    .all<{ post_id: string }>();

  return jsonLd(
    activityContentType(c.req.header('accept')),
    collection({
      id: `${collections.liked}?page=${current}`,
      type: 'OrderedCollectionPage',
      totalItems,
      items: (likes.results ?? []).map((row) => noteUrl(c.env.BASE_URL, row.post_id)),
      partOf: collections.liked,
      next: offset + COLLECTION_PAGE_SIZE < totalItems ? `${collections.liked}?page=${current + 1}` : undefined,
      prev: current > 1 ? `${collections.liked}?page=${current - 1}` : undefined,
    }),
  );
});

// GET /api/actors/:username/featured - ActivityPub Featured collection
app.get('/api/actors/:username/featured', async (c) => {
  const username = c.req.param('username');
  const user = await findActor(c.env.DB, username);
  if (!user) return c.json({ error: 'User not found' }, 404);

  const collections = actorCollectionUrls(c.env.BASE_URL, username);
  return jsonLd(
    activityContentType(c.req.header('accept')),
    collection({ id: collections.featured, type: 'OrderedCollection', totalItems: 0, items: [] }),
  );
});

// GET /api/actors/:username/outbox - ActivityPub Outbox endpoint (paginated)
app.get('/api/actors/:username/outbox', async (c) => {
  const username = c.req.param('username');
  const user = await findActor(c.env.DB, username);
  if (!user) return c.json({ error: 'User not found' }, 404);

  const collections = actorCollectionUrls(c.env.BASE_URL, username);
  const totalItems =
    (
      await c.env.DB.prepare(
        "SELECT COUNT(*) as total FROM posts WHERE user_id = ? AND status = 'published' AND hidden = 0",
      )
        .bind(user.id)
        .first<{ total: number }>()
    )?.total ?? 0;

  const page = c.req.query('page');
  if (!page) {
    return jsonLd(
      activityContentType(c.req.header('accept')),
      collection({ id: collections.outbox, type: 'OrderedCollection', totalItems }),
    );
  }

  const current = pageNumber(page);
  const offset = (current - 1) * COLLECTION_PAGE_SIZE;
  const posts = await c.env.DB.prepare(
    `SELECT id, text, created_at FROM posts
     WHERE user_id = ? AND status = 'published' AND hidden = 0
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, COLLECTION_PAGE_SIZE, offset)
    .all<{ id: string; text: string; created_at: string }>();

  const activities = (posts.results ?? []).map((post) => {
    const note = buildNoteObject(
      { id: post.id, text: post.text, created_at: post.created_at, visibility: 'public' },
      { id: user.id, username: user.username, display_name: user.display_name },
      c.env.BASE_URL,
      { followersUrl: collections.followers },
    );
    return buildCreateActivity(
      note,
      { id: user.id, username: user.username, display_name: user.display_name },
      c.env.BASE_URL,
    );
  });

  const document: Record<string, unknown> = {
    '@context': AS2_CONTEXT,
    id: `${collections.outbox}?page=${current}`,
    type: 'OrderedCollectionPage',
    totalItems,
    orderedItems: activities,
    partOf: collections.outbox,
  };
  if (offset + COLLECTION_PAGE_SIZE < totalItems) document.next = `${collections.outbox}?page=${current + 1}`;
  if (current > 1) document.prev = `${collections.outbox}?page=${current - 1}`;

  return jsonLd(activityContentType(c.req.header('accept')), document);
});

// GET /notes/:noteId - ActivityPub Note endpoint
app.get('/notes/:noteId', async (c) => {
  const noteId = c.req.param('noteId');
  if (!noteId) return c.json({ error: 'Note ID required' }, 400);

  const post = await c.env.DB.prepare(
    `SELECT p.id, p.text, p.created_at, p.user_id, p.username FROM posts p
     WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0
       AND p.user_id IN (SELECT id FROM users WHERE frozen_at IS NULL)`,
  )
    .bind(noteId)
    .first<{ id: string; text: string; created_at: string; user_id: string; username: string }>();
  if (!post) return c.json({ error: 'Note not found' }, 404);

  const user = await c.env.DB.prepare(
    'SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE AND frozen_at IS NULL',
  )
    .bind(post.username)
    .first<{ id: string; username: string; display_name: string | null }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const collections = actorCollectionUrls(c.env.BASE_URL, user.username);
  const note = buildNoteObject(
    { id: post.id, text: post.text, created_at: post.created_at, visibility: 'public' },
    { id: user.id, username: user.username, display_name: user.display_name },
    c.env.BASE_URL,
    { followersUrl: collections.followers },
  );

  return jsonLd(activityContentType(c.req.header('accept')), note);
});

// GET /api/notes/:noteId - ActivityPub Note endpoint (no /api prefix)
app.get('/api/notes/:noteId', async (c) => {
  const noteId = c.req.param('noteId');
  if (!noteId) return c.json({ error: 'Note ID required' }, 400);

  const post = await c.env.DB.prepare(
    `SELECT p.id, p.text, p.created_at, p.user_id, p.username FROM posts p
     WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0
       AND p.user_id IN (SELECT id FROM users WHERE frozen_at IS NULL)`,
  )
    .bind(noteId)
    .first<{ id: string; text: string; created_at: string; user_id: string; username: string }>();
  if (!post) return c.json({ error: 'Note not found' }, 404);

  const user = await c.env.DB.prepare(
    'SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE AND frozen_at IS NULL',
  )
    .bind(post.username)
    .first<{ id: string; username: string; display_name: string | null }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const collections = actorCollectionUrls(c.env.BASE_URL, user.username);
  const note = buildNoteObject(
    { id: post.id, text: post.text, created_at: post.created_at, visibility: 'public' },
    { id: user.id, username: user.username, display_name: user.display_name },
    c.env.BASE_URL,
    { followersUrl: collections.followers },
  );

  return jsonLd(activityContentType(c.req.header('accept')), note);
});

export default app;
