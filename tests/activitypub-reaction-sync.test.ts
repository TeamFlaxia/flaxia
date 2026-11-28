import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type HandlerEnv, handleIncomingActivity, REMOTE_LIKE_EMOJI } from '../functions/lib/activitypub/handlers.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

const BASE = 'https://flaxia.app';
const REMOTE = 'https://remote.example';
const ACTOR = `${REMOTE}/users/alice`;
const OTHER_ACTOR = `${REMOTE}/users/bob`;

function envFor(db: TestDatabase): HandlerEnv {
  return { DB: db as unknown as HandlerEnv['DB'], BASE_URL: BASE };
}

function likeActivity(activityId: string, postId: string, actor = ACTOR): Record<string, unknown> {
  return { id: activityId, type: 'Like', actor, object: `${BASE}/api/notes/${postId}` };
}

function undoLikeActivity(activityId: string, like: Record<string, unknown>, actor = ACTOR): Record<string, unknown> {
  return { id: activityId, type: 'Undo', actor, object: like };
}

async function publishPost(db: TestDatabase, postId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, status, created_at)
       VALUES (?, 'local-1', 'alice', 'a local post', 'published', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(postId)
    .run();
}

async function reactionCount(db: TestDatabase, postId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?')
    .bind(postId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function engagement(db: TestDatabase, postId: string) {
  const row = await db
    .prepare('SELECT fresh_count, engagement_hotness FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ fresh_count: number; engagement_hotness: number }>();
  assert.ok(row, 'the post must exist');
  return { fresh_count: row.fresh_count, engagement_hotness: Number(row.engagement_hotness) };
}

describe('ActivityPub Like reactions on local posts', () => {
  let db: TestDatabase;

  before(async () => {
    db = createTestDatabase();
    await seedLocalUser(db, { id: 'local-1', username: 'alice', displayName: 'Alice' });
  });

  after(() => {
    db.close();
  });

  it('adds a remote Like to the reaction summary and to the Fresh counter', async () => {
    await publishPost(db, 'reaction-basic');

    await handleIncomingActivity(envFor(db), {
      actorId: ACTOR,
      username: 'alice',
      activity: likeActivity(`${REMOTE}/activities/like-basic`, 'reaction-basic'),
    });

    assert.equal(await reactionCount(db, 'reaction-basic'), 1, 'the Like must appear as a reaction');
    const reaction = await db
      .prepare('SELECT user_id, emoji FROM reactions WHERE post_id = ?')
      .bind('reaction-basic')
      .first<{ user_id: string; emoji: string }>();
    assert.equal(reaction?.user_id, ACTOR, 'the signed actor owns the remote reaction');
    assert.equal(reaction?.emoji, REMOTE_LIKE_EMOJI);
    assert.deepEqual(await engagement(db, 'reaction-basic'), { fresh_count: 1, engagement_hotness: 3 });
  });

  it('does not double count a Like delivered more than once', async () => {
    await publishPost(db, 'reaction-duplicate');
    const like = likeActivity(`${REMOTE}/activities/like-duplicate`, 'reaction-duplicate');

    await handleIncomingActivity(envFor(db), { actorId: ACTOR, username: 'alice', activity: like });
    // A retry with the same id is skipped by the activity claim; a peer that
    // re-sends the Like under a new id is stopped by the unique like/actor row.
    await handleIncomingActivity(envFor(db), { actorId: ACTOR, username: 'alice', activity: like });
    await handleIncomingActivity(envFor(db), {
      actorId: ACTOR,
      username: 'alice',
      activity: { ...like, id: `${REMOTE}/activities/like-duplicate-2` },
    });

    assert.equal(await reactionCount(db, 'reaction-duplicate'), 1);
    const likes = await db
      .prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ? AND actor_id = ?')
      .bind('reaction-duplicate', ACTOR)
      .first<{ n: number }>();
    assert.equal(likes?.n, 1);
    assert.deepEqual(await engagement(db, 'reaction-duplicate'), { fresh_count: 1, engagement_hotness: 3 });
  });

  it('retracts only the remote reaction on Undo-Like', async () => {
    await publishPost(db, 'reaction-undo');
    await db
      .prepare('INSERT INTO reactions (post_id, user_id, emoji) VALUES (?, ?, ?)')
      .bind('reaction-undo', 'local-1', REMOTE_LIKE_EMOJI)
      .run();
    const like = likeActivity(`${REMOTE}/activities/like-undo`, 'reaction-undo');
    await handleIncomingActivity(envFor(db), { actorId: ACTOR, username: 'alice', activity: like });
    assert.equal(await reactionCount(db, 'reaction-undo'), 2);

    await handleIncomingActivity(envFor(db), {
      actorId: ACTOR,
      username: 'alice',
      activity: undoLikeActivity(`${REMOTE}/activities/undo-like-undo`, like),
    });

    assert.equal(await reactionCount(db, 'reaction-undo'), 1, 'the local reaction must survive the Undo');
    const remaining = await db
      .prepare('SELECT user_id FROM reactions WHERE post_id = ?')
      .bind('reaction-undo')
      .first<{ user_id: string }>();
    assert.equal(remaining?.user_id, 'local-1');
    assert.deepEqual(await engagement(db, 'reaction-undo'), { fresh_count: 0, engagement_hotness: 1 });

    // A second Undo cannot drive the counters below their baseline.
    await handleIncomingActivity(envFor(db), {
      actorId: ACTOR,
      username: 'alice',
      activity: undoLikeActivity(`${REMOTE}/activities/undo-like-undo-again`, like),
    });
    assert.deepEqual(await engagement(db, 'reaction-undo'), { fresh_count: 0, engagement_hotness: 1 });
  });

  it('leaves reactions untouched for unresolvable posts and unrelated activities', async () => {
    await publishPost(db, 'reaction-unrelated');

    await handleIncomingActivity(envFor(db), {
      actorId: ACTOR,
      username: 'alice',
      activity: likeActivity(`${REMOTE}/activities/like-missing`, 'does-not-exist'),
    });
    const announce = {
      id: `${REMOTE}/activities/announce-unrelated`,
      type: 'Announce',
      actor: ACTOR,
      object: `${BASE}/api/notes/reaction-unrelated`,
    };
    await handleIncomingActivity(envFor(db), { actorId: ACTOR, username: 'alice', activity: announce });
    await handleIncomingActivity(envFor(db), {
      actorId: ACTOR,
      username: 'alice',
      activity: undoLikeActivity(`${REMOTE}/activities/undo-unrelated`, {
        type: 'Like',
        actor: ACTOR,
        object: `${BASE}/api/notes/reaction-unrelated`,
      }),
    });

    assert.equal(await reactionCount(db, 'reaction-unrelated'), 0);
    // Only the Announce moves engagement, by its own +3 hotness: no Fresh or
    // reaction was added by the missing Like or the unrelated Undo.
    assert.deepEqual(await engagement(db, 'reaction-unrelated'), { fresh_count: 0, engagement_hotness: 4 });
    const reload = await db
      .prepare('SELECT reload_count FROM posts WHERE id = ?')
      .bind('reaction-unrelated')
      .first<{ reload_count: number }>();
    assert.equal(reload?.reload_count, 1, 'the unrelated Announce must keep its own behaviour');
  });

  it('ignores a Like from an actor blocked by the post author', async () => {
    await publishPost(db, 'reaction-blocked');
    await db
      .prepare('INSERT INTO ap_blocks (id, local_user_id, actor_url) VALUES (?, ?, ?)')
      .bind('block-reaction', 'local-1', OTHER_ACTOR)
      .run();

    await handleIncomingActivity(envFor(db), {
      actorId: OTHER_ACTOR,
      username: 'alice',
      activity: likeActivity(`${REMOTE}/activities/like-blocked`, 'reaction-blocked', OTHER_ACTOR),
    });

    assert.equal(await reactionCount(db, 'reaction-blocked'), 0);
    assert.deepEqual(await engagement(db, 'reaction-blocked'), { fresh_count: 0, engagement_hotness: 1 });
  });
});
