import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type HandlerEnv, handleIncomingActivity } from '../functions/lib/activitypub/handlers.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const REMOTE_ACTOR = `${REMOTE}/users/alice`;
const REMOTE_BOB = `${REMOTE}/users/bob`;

interface QueueMessage {
  type: string;
  inboxUrl?: string;
  activity?: Record<string, unknown>;
  senderUsername?: string;
}

function envFor(db: TestDatabase, queue: QueueMessage[] = []): HandlerEnv {
  return {
    DB: db as unknown as HandlerEnv['DB'],
    BASE_URL: BASE,
    AP_DELIVERY_QUEUE: {
      async send(message: QueueMessage) {
        queue.push(message);
      },
    } as unknown as HandlerEnv['AP_DELIVERY_QUEUE'],
  };
}

/** Stub the remote actor document the handler fetches. */
function stubRemoteActor(originalFetch: typeof fetch): () => void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(REMOTE)) {
      return new Response('not found', { status: 404 });
    }
    const actorUrl = url.replace(/\/$/, '');
    const username = actorUrl.split('/').pop() ?? 'alice';
    return new Response(
      JSON.stringify({
        id: actorUrl,
        type: 'Person',
        preferredUsername: username,
        name: `${username} Remote`,
        inbox: `${actorUrl}/inbox`,
        endpoints: { sharedInbox: `${REMOTE}/inbox` },
        publicKey: {
          id: `${actorUrl}#main-key`,
          owner: actorUrl,
          publicKeyPem: '-----BEGIN PUBLIC KEY-----',
        },
      }),
      { headers: { 'Content-Type': 'application/activity+json' } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe('ActivityPub inbox handlers', () => {
  let db: TestDatabase;

  before(async () => {
    db = createTestDatabase();
    await seedLocalUser(db, { id: 'local-1', username: 'alice', displayName: 'Alice' });
    await db
      .prepare(
        `INSERT INTO posts (id, user_id, username, text, hashtags, status, created_at)
         VALUES ('post-1', 'local-1', 'alice', 'hello', '[]', 'published', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
  });

  after(() => {
    db.close();
  });

  it('stores a Note of an account the user follows and answers it with a mention notification', async () => {
    const originalFetch = globalThis.fetch;
    const restore = stubRemoteActor(originalFetch);
    try {
      await db
        .prepare(
          `INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, status, created_at)
           VALUES ('following-create', 'local-1', ?, ?, 'accepted', '2026-01-01T00:00:00.000Z')`,
        )
        .bind(REMOTE_ACTOR, `${REMOTE}/users/alice/inbox`)
        .run();
      await db
        .prepare(
          `INSERT INTO ap_actors (actor_url, inbox_url, shared_inbox_url, preferred_username, display_name, domain)
           VALUES (?, ?, ?, 'alice', 'Alice Remote', 'remote.example')`,
        )
        .bind(REMOTE_ACTOR, `${REMOTE}/users/alice/inbox`, `${REMOTE}/inbox`)
        .run();
      await db
        .prepare(
          `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
           VALUES ('local-2', 'bob@test.com', '', 'bob', 'Bob', '', '2026-01-01T00:00:00.000Z')`,
        )
        .run();

      await handleIncomingActivity(envFor(db), {
        actorId: REMOTE_ACTOR,
        username: 'alice',
        activity: {
          id: `${REMOTE}/activities/1`,
          type: 'Create',
          actor: REMOTE_ACTOR,
          object: {
            id: `${REMOTE}/notes/1`,
            type: 'Note',
            attributedTo: REMOTE_ACTOR,
            content: '<p>hi <a href="https://flaxia.app/users/bob">@bob</a> #flaxia</p>',
            published: '2026-01-02T00:00:00.000Z',
            tag: [
              { type: 'Mention', name: '@bob', href: 'https://flaxia.app/users/bob' },
              { type: 'Hashtag', name: '#flaxia', href: 'https://flaxia.app/tags/flaxia' },
            ],
          },
        },
      });

      const post = await db
        .prepare('SELECT text, hashtags, actor_id, ap_object_id, user_id, username FROM posts WHERE actor_id = ?')
        .bind(REMOTE_ACTOR)
        .first<{
          text: string;
          hashtags: string;
          actor_id: string;
          ap_object_id: string;
          user_id: string;
          username: string;
        }>();
      assert.ok(post, 'the note of the follower must be stored');
      assert.equal(post.text, 'hi @bob #flaxia');
      assert.deepEqual(JSON.parse(post.hashtags), ['flaxia']);
      assert.equal(post.ap_object_id, `${REMOTE}/notes/1`);
      assert.equal(post.user_id, '', 'a remote note is not owned by the local recipient');
      assert.equal(post.username, 'alice@remote.example');

      const notification = await db
        .prepare("SELECT type FROM notifications WHERE user_id = 'local-2' AND type = 'mention'")
        .first<{ type: string }>();
      assert.ok(notification, 'the mentioned local account must be notified');
    } finally {
      restore();
    }
  });

  it('stores the same Note only once even with different activity ids', async () => {
    const object = {
      id: `${REMOTE}/notes/duplicate`,
      type: 'Note',
      attributedTo: REMOTE_ACTOR,
      content: 'only once',
    };
    for (const activityId of ['duplicate-1', 'duplicate-2']) {
      await handleIncomingActivity(envFor(db), {
        actorId: REMOTE_ACTOR,
        username: 'alice',
        activity: {
          id: `${REMOTE}/activities/${activityId}`,
          type: 'Create',
          actor: REMOTE_ACTOR,
          object,
        },
      });
    }
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM posts WHERE ap_object_id = ?')
      .bind(object.id)
      .first<{ n: number }>();
    assert.equal(count?.n, 1);
  });

  it('ignores a Note whose object id lives on another origin', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_ACTOR,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/foreign-object`,
        type: 'Create',
        actor: REMOTE_ACTOR,
        object: {
          id: `${BASE}/notes/post-1`,
          type: 'Note',
          attributedTo: REMOTE_ACTOR,
          content: 'not a local note',
        },
      },
    });
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM posts WHERE ap_object_id = ?')
      .bind(`${BASE}/notes/post-1`)
      .first<{ n: number }>();
    assert.equal(count?.n, 0);
  });

  it('stores a remote Note once even when two local accounts follow the actor', async () => {
    await db
      .prepare(
        `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
         VALUES ('local-3', 'carol@test.com', '', 'carol', 'Carol', '', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, status, created_at)
         VALUES ('following-carol', 'local-3', ?, ?, 'accepted', '2026-01-01T00:00:00.000Z')`,
      )
      .bind(REMOTE_ACTOR, `${REMOTE}/users/alice/inbox`)
      .run();
    const object = {
      id: `${REMOTE}/notes/shared-recipient`,
      type: 'Note',
      attributedTo: REMOTE_ACTOR,
      content: 'shared with two followers',
    };
    for (const [username, activityId] of [
      ['alice', 'recipient-alice'],
      ['carol', 'recipient-carol'],
    ]) {
      await handleIncomingActivity(envFor(db), {
        actorId: REMOTE_ACTOR,
        username,
        activity: {
          id: `${REMOTE}/activities/${activityId}`,
          type: 'Create',
          actor: REMOTE_ACTOR,
          object,
        },
      });
    }
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM posts WHERE ap_object_id = ?')
      .bind(object.id)
      .first<{ n: number }>();
    assert.equal(count?.n, 1);
    const owner = await db
      .prepare('SELECT user_id FROM posts WHERE ap_object_id = ?')
      .bind(object.id)
      .first<{ user_id: string }>();
    assert.equal(owner?.user_id, '');
  });

  it('ignores a Note of a follower the account does not follow back', async () => {
    const followerOnly = `${REMOTE}/users/stranger`;
    await db
      .prepare(
        `INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, created_at)
         VALUES ('follower-only', 'local-1', ?, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .bind(followerOnly, `${followerOnly}/inbox`)
      .run();
    await handleIncomingActivity(envFor(db), {
      actorId: followerOnly,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/follower-only`,
        type: 'Create',
        actor: followerOnly,
        object: {
          id: `${REMOTE}/notes/follower-only`,
          type: 'Note',
          attributedTo: followerOnly,
          content: 'not in my timeline',
        },
      },
    });
    const post = await db.prepare('SELECT id FROM posts WHERE actor_id = ?').bind(followerOnly).first<{ id: string }>();
    assert.equal(post, null);
  });

  it('ignores a Note of an actor that does not follow the account', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: `${REMOTE}/users/stranger`,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/2`,
        type: 'Create',
        actor: `${REMOTE}/users/stranger`,
        object: {
          id: `${REMOTE}/notes/2`,
          type: 'Note',
          attributedTo: `${REMOTE}/users/stranger`,
          content: 'spam',
        },
      },
    });
    const post = await db
      .prepare('SELECT id FROM posts WHERE actor_id = ?')
      .bind(`${REMOTE}/users/stranger`)
      .first<{ id: string }>();
    assert.equal(post, null);
  });

  it('ignores a Note that is attributed to another actor', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_ACTOR,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/3`,
        type: 'Create',
        actor: REMOTE_ACTOR,
        object: {
          id: `${REMOTE}/notes/3`,
          type: 'Note',
          attributedTo: `${REMOTE}/users/mallory`,
          content: 'not mine',
        },
      },
    });
    const post = await db
      .prepare('SELECT id FROM posts WHERE ap_object_id = ?')
      .bind(`${REMOTE}/notes/3`)
      .first<{ id: string }>();
    assert.equal(post, null);
  });

  it('records a follower and queues the Accept', async () => {
    const originalFetch = globalThis.fetch;
    const restore = stubRemoteActor(originalFetch);
    const queue: QueueMessage[] = [];
    try {
      await handleIncomingActivity(envFor(db, queue), {
        actorId: REMOTE_BOB,
        username: 'alice',
        activity: {
          id: `${REMOTE}/activities/4`,
          type: 'Follow',
          actor: REMOTE_BOB,
          object: `${BASE}/api/actors/alice`,
        },
      });

      const follower = await db
        .prepare(
          'SELECT actor_url, inbox_url, shared_inbox_url, username, domain FROM ap_followers WHERE actor_url = ?',
        )
        .bind(REMOTE_BOB)
        .first<{ actor_url: string; inbox_url: string; shared_inbox_url: string; username: string; domain: string }>();
      assert.ok(follower);
      assert.equal(follower.username, 'bob');
      assert.equal(follower.domain, 'remote.example');
      assert.equal(follower.shared_inbox_url, `${REMOTE}/inbox`);

      assert.equal(queue.length, 1);
      assert.equal(queue[0].type, 'delivery');
      assert.equal(queue[0].inboxUrl, `${REMOTE}/users/bob/inbox`);
      assert.equal(queue[0].activity?.type, 'Accept');
      assert.equal(queue[0].activity?.actor, `${BASE}/api/actors/alice`);

      const notification = await db
        .prepare("SELECT type FROM notifications WHERE user_id = 'local-1' AND type = 'ap_follow'")
        .first<{ type: string }>();
      assert.ok(notification, 'the followed account must be notified');
    } finally {
      restore();
    }
  });

  it('accepts a Follow only once', async () => {
    const originalFetch = globalThis.fetch;
    const restore = stubRemoteActor(originalFetch);
    const queue: QueueMessage[] = [];
    try {
      await handleIncomingActivity(envFor(db, queue), {
        actorId: REMOTE_BOB,
        username: 'alice',
        activity: {
          id: `${REMOTE}/activities/5`,
          type: 'Follow',
          actor: REMOTE_BOB,
          object: `${BASE}/api/actors/alice`,
        },
      });
      assert.equal(queue.length, 0, 'a repeated follow must not queue a second Accept');
    } finally {
      restore();
    }
  });

  it('marks a remote follow as accepted and as rejected', async () => {
    await db
      .prepare(
        `INSERT OR REPLACE INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, status, created_at)
         VALUES ('following-1', 'local-1', ?, ?, 'sent', '2026-01-01T00:00:00.000Z')`,
      )
      .bind(REMOTE_BOB, `${REMOTE}/users/bob/inbox`)
      .run();

    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_BOB,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/6`,
        type: 'Accept',
        actor: REMOTE_BOB,
        object: {
          id: `${BASE}/activities/follow-1`,
          type: 'Follow',
          actor: `${BASE}/api/actors/alice`,
          object: REMOTE_BOB,
        },
      },
    });

    let following = await db
      .prepare('SELECT status FROM ap_following WHERE id = ?')
      .bind('following-1')
      .first<{ status: string }>();
    assert.equal(following?.status, 'accepted');

    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_BOB,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/7`,
        type: 'Reject',
        actor: REMOTE_BOB,
        object: {
          id: `${BASE}/activities/follow-2`,
          type: 'Follow',
          actor: `${BASE}/api/actors/alice`,
          object: REMOTE_BOB,
        },
      },
    });
    following = await db
      .prepare('SELECT status FROM ap_following WHERE id = ?')
      .bind('following-1')
      .first<{ status: string }>();
    assert.equal(following?.status, 'rejected');
  });

  it('records a like of a local post and removes it again', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_ACTOR,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/8`,
        type: 'Like',
        actor: REMOTE_ACTOR,
        object: `${BASE}/notes/post-1`,
      },
    });

    let like = await db
      .prepare('SELECT post_id, actor_id FROM likes WHERE actor_id = ?')
      .bind(REMOTE_ACTOR)
      .first<{ post_id: string; actor_id: string }>();
    assert.equal(like?.post_id, 'post-1');

    const notification = await db
      .prepare("SELECT type FROM notifications WHERE type = 'ap_like'")
      .first<{ type: string }>();
    assert.ok(notification, 'the author must be notified about the remote like');

    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_ACTOR,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/9`,
        type: 'Undo',
        actor: REMOTE_ACTOR,
        object: { id: `${REMOTE}/activities/8`, type: 'Like', actor: REMOTE_ACTOR, object: `${BASE}/notes/post-1` },
      },
    });

    like = await db
      .prepare('SELECT post_id FROM likes WHERE actor_id = ?')
      .bind(REMOTE_ACTOR)
      .first<{ post_id: string }>();
    assert.equal(like, null);
  });

  it('records an announce of a local post and removes it again', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_ACTOR,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/10`,
        type: 'Announce',
        actor: REMOTE_ACTOR,
        object: `${BASE}/notes/post-1`,
      },
    });

    let share = await db
      .prepare('SELECT post_id FROM shares WHERE actor_id = ?')
      .bind(REMOTE_ACTOR)
      .first<{ post_id: string }>();
    assert.equal(share?.post_id, 'post-1');

    const counter = await db
      .prepare('SELECT reload_count FROM posts WHERE id = ?')
      .bind('post-1')
      .first<{ reload_count: number }>();
    assert.equal(counter?.reload_count, 1);

    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_ACTOR,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/11`,
        type: 'Undo',
        actor: REMOTE_ACTOR,
        object: {
          id: `${REMOTE}/activities/10`,
          type: 'Announce',
          actor: REMOTE_ACTOR,
          object: `${BASE}/notes/post-1`,
        },
      },
    });

    share = await db
      .prepare('SELECT post_id FROM shares WHERE actor_id = ?')
      .bind(REMOTE_ACTOR)
      .first<{ post_id: string }>();
    assert.equal(share, null);
  });

  it('deletes a remote post when its author deletes it', async () => {
    const originalFetch = globalThis.fetch;
    const restore = stubRemoteActor(originalFetch);
    try {
      await handleIncomingActivity(envFor(db), {
        actorId: REMOTE_ACTOR,
        username: 'alice',
        activity: {
          id: `${REMOTE}/activities/12`,
          type: 'Create',
          actor: REMOTE_ACTOR,
          object: {
            id: `${REMOTE}/notes/12`,
            type: 'Note',
            attributedTo: REMOTE_ACTOR,
            content: 'temporary',
          },
        },
      });

      const stored = await db
        .prepare('SELECT id FROM posts WHERE ap_object_id = ?')
        .bind(`${REMOTE}/notes/12`)
        .first<{ id: string }>();
      assert.ok(stored);

      await handleIncomingActivity(envFor(db), {
        actorId: REMOTE_ACTOR,
        username: 'alice',
        activity: {
          id: `${REMOTE}/activities/13`,
          type: 'Delete',
          actor: REMOTE_ACTOR,
          object: { id: `${REMOTE}/notes/12`, type: 'Tombstone' },
        },
      });

      const deleted = await db
        .prepare('SELECT status, hidden FROM posts WHERE id = ?')
        .bind(stored.id)
        .first<{ status: string; hidden: number }>();
      assert.equal(deleted?.status, 'deleted');
      assert.equal(deleted?.hidden, 1);
    } finally {
      restore();
    }
  });

  it('never deletes a post of another actor', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: `${REMOTE}/users/mallory`,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/14`,
        type: 'Delete',
        actor: `${REMOTE}/users/mallory`,
        object: { id: `${BASE}/notes/post-1`, type: 'Tombstone' },
      },
    });

    const post = await db.prepare('SELECT status FROM posts WHERE id = ?').bind('post-1').first<{ status: string }>();
    assert.equal(post?.status, 'published');
  });

  it('removes a follower when the follow is undone', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_BOB,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/15`,
        type: 'Undo',
        actor: REMOTE_BOB,
        object: { id: `${REMOTE}/activities/4`, type: 'Follow', actor: REMOTE_BOB, object: `${BASE}/api/actors/alice` },
      },
    });

    const follower = await db
      .prepare('SELECT id FROM ap_followers WHERE actor_url = ?')
      .bind(REMOTE_BOB)
      .first<{ id: string }>();
    assert.equal(follower, null);
  });

  it('records the blocker, not the blocked local actor', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_ACTOR,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/block`,
        type: 'Block',
        actor: REMOTE_ACTOR,
        object: `${BASE}/api/actors/alice`,
      },
    });
    const block = await db
      .prepare('SELECT actor_url FROM ap_blocks WHERE local_user_id = ? AND actor_url = ?')
      .bind('local-1', REMOTE_ACTOR)
      .first<{ actor_url: string }>();
    assert.ok(block, 'the remote blocker must be recorded');
    const selfBlock = await db
      .prepare('SELECT actor_url FROM ap_blocks WHERE local_user_id = ? AND actor_url = ?')
      .bind('local-1', `${BASE}/api/actors/alice`)
      .first<{ actor_url: string }>();
    assert.equal(selfBlock, null, 'the local actor must not block itself');
    await db
      .prepare('DELETE FROM ap_blocks WHERE local_user_id = ? AND actor_url = ?')
      .bind('local-1', REMOTE_ACTOR)
      .run();
  });

  it('updates the cached profile of a remote actor', async () => {
    await handleIncomingActivity(envFor(db), {
      actorId: REMOTE_ACTOR,
      username: 'alice',
      activity: {
        id: `${REMOTE}/activities/16`,
        type: 'Update',
        actor: REMOTE_ACTOR,
        object: {
          id: REMOTE_ACTOR,
          type: 'Person',
          attributedTo: REMOTE_ACTOR,
          name: 'Alice Renamed',
          preferredUsername: 'alice',
        },
      },
    });

    const actor = await db
      .prepare('SELECT display_name FROM ap_actors WHERE actor_url = ?')
      .bind(REMOTE_ACTOR)
      .first<{ display_name: string }>();
    assert.equal(actor?.display_name, 'Alice Renamed');
  });

  it('caches the actor document of a follower', async () => {
    const actor = await db
      .prepare('SELECT preferred_username, inbox_url, shared_inbox_url FROM ap_actors WHERE actor_url = ?')
      .bind(REMOTE_BOB)
      .first<{ preferred_username: string; inbox_url: string; shared_inbox_url: string }>();
    assert.equal(actor?.preferred_username, 'bob');
    assert.equal(actor?.inbox_url, `${REMOTE}/users/bob/inbox`);
    assert.equal(actor?.shared_inbox_url, `${REMOTE}/inbox`);
  });

  it('processes an activity only once', async () => {
    const originalFetch = globalThis.fetch;
    const restore = stubRemoteActor(originalFetch);
    const queue: QueueMessage[] = [];
    try {
      const activity = {
        id: `${REMOTE}/activities/17`,
        type: 'Follow',
        actor: REMOTE_ACTOR,
        object: `${BASE}/api/actors/alice`,
      };
      await handleIncomingActivity(envFor(db, queue), { actorId: REMOTE_ACTOR, username: 'alice', activity });
      const first = queue.length;
      await handleIncomingActivity(envFor(db, queue), { actorId: REMOTE_ACTOR, username: 'alice', activity });
      assert.equal(queue.length, first, 'a replayed activity must not be processed twice');
    } finally {
      restore();
    }
  });
});
