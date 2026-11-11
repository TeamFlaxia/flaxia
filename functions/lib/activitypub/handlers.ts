/// <reference types="@cloudflare/workers-types" />

import { buildAcceptActivity } from './activities.ts';
import { actorUrl, localProfileUsername, noteUrl } from './actor.ts';
import { type FederationEnv, resolveRemoteActor } from './fetch.ts';
import { htmlToText } from './text.ts';

/**
 * Processing of the activities this instance receives.
 *
 * The handlers only ever trust the actor that signed the request: the
 * activity is attributed to the verified actor and an activity may not act on
 * behalf of somebody else. Every activity is claimed once, so a delivery that
 * is retried does not create the same follower or like twice.
 */

export interface HandlerEnv extends FederationEnv {
  DB: D1Database;
  BASE_URL: string;
  AP_DELIVERY_QUEUE?: Queue;
}

export interface IncomingActivity {
  activity: Record<string, unknown>;
  actorId: string;
  /** Local account the activity was addressed to. */
  username: string;
}

const MAX_REMOTE_TEXT_LENGTH = 200;

function objectOf(activity: Record<string, unknown>): Record<string, unknown> | null {
  const object = activity.object;
  if (typeof object === 'string') return { id: object };
  if (typeof object === 'object' && object !== null) return object as Record<string, unknown>;
  return null;
}

function activityType(activity: Record<string, unknown>): string {
  return typeof activity.type === 'string' ? activity.type : '';
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomPostId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const values = new Uint8Array(10);
  crypto.getRandomValues(values);
  let result = '';
  for (let i = 0; i < 10; i++) result += alphabet[values[i] % alphabet.length];
  return result;
}

/** Local post id of a note URL of this instance, or null. */
export function localPostIdFromNoteUrl(url: unknown, baseUrl: string): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  const match = parsed.pathname.match(/^\/notes\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function localUserId(env: HandlerEnv, username: string): Promise<string | null> {
  const user = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first<{ id: string }>();
  return user?.id ?? null;
}

/**
 * Claim an activity.
 *
 * Returns false when the activity was already processed. The claim is
 * released again when processing fails, so a retried delivery is not lost.
 */
async function claimActivity(env: HandlerEnv, activity: Record<string, unknown>): Promise<boolean> {
  const activityId = typeof activity.id === 'string' ? activity.id : null;
  if (!activityId) return true;
  const result = await env.DB.prepare('INSERT OR IGNORE INTO ap_activities (activity_id) VALUES (?)')
    .bind(activityId)
    .run();
  if ((result.meta?.changes ?? 0) > 0) return true;
  const existing = await env.DB.prepare('SELECT activity_id FROM ap_activities WHERE activity_id = ?')
    .bind(activityId)
    .first<{ activity_id: string }>();
  if (!existing) return true;
  return false;
}

async function releaseActivity(env: HandlerEnv, activity: Record<string, unknown>): Promise<void> {
  const activityId = typeof activity.id === 'string' ? activity.id : null;
  if (!activityId) return;
  await env.DB.prepare('DELETE FROM ap_activities WHERE activity_id = ?').bind(activityId).run();
}

/**
 * Process one received activity.
 */
export async function handleIncomingActivity(env: HandlerEnv, incoming: IncomingActivity): Promise<void> {
  const { activity, actorId, username } = incoming;
  const type = activityType(activity);

  const claimed = await claimActivity(env, activity);
  if (!claimed) {
    console.log(`Skipping already processed activity: ${activity.id ?? type}`);
    return;
  }

  try {
    switch (type) {
      case 'Create':
        await handleCreate(env, activity, actorId, username);
        break;
      case 'Follow':
        await handleFollow(env, activity, actorId, username);
        break;
      case 'Accept':
        await handleAccept(env, activity, actorId, username);
        break;
      case 'Reject':
        await handleReject(env, activity, actorId, username);
        break;
      case 'Like':
        await handleLike(env, activity, actorId, username);
        break;
      case 'Announce':
        await handleAnnounce(env, activity, actorId, username);
        break;
      case 'Undo':
        await handleUndo(env, activity, actorId, username);
        break;
      case 'Delete':
        await handleDelete(env, activity, actorId, username);
        break;
      case 'Update':
        await handleUpdate(env, activity, actorId, username);
        break;
      case 'Block':
        await handleBlock(env, activity, actorId, username);
        break;
      case 'Move':
        await handleMove(env, activity, actorId, username);
        break;
      default:
        console.log(`Unsupported ActivityPub activity: ${type}`);
    }
  } catch (error: unknown) {
    await releaseActivity(env, activity);
    throw error;
  }
}

interface NoteTag {
  type?: unknown;
  name?: unknown;
  href?: unknown;
}

async function handleCreate(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  if (!object || object.type !== 'Note') {
    console.log('Ignoring Create activity with non-Note object');
    return;
  }

  const content = object.content;
  if (typeof content !== 'string') {
    console.error('Note missing content');
    return;
  }

  const text = htmlToText(content).slice(0, MAX_REMOTE_TEXT_LENGTH);

  // The Note must be attributed to the signing actor; otherwise any holder of
  // a federated signing key could publish content under another actor's name.
  const attributedTo = object.attributedTo;
  const attributedMatch =
    typeof attributedTo === 'string'
      ? attributedTo === actorId
      : Array.isArray(attributedTo) && attributedTo.includes(actorId);
  if (!attributedMatch) {
    console.error('Note attributedTo does not match signing actor');
    return;
  }

  const userId = await localUserId(env, username);
  if (!userId) {
    console.error('User not found:', username);
    return;
  }

  // Only actors the target user follows may have their Notes published.
  const followRel = await env.DB.prepare('SELECT id FROM ap_followers WHERE local_user_id = ? AND actor_url = ?')
    .bind(userId, actorId)
    .first();
  if (!followRel) {
    console.error('Ignoring Create from non-follower actor:', actorId);
    return;
  }

  const parentId = localPostIdFromNoteUrl(object.inReplyTo, env.BASE_URL);
  let rootId: string | null = null;
  let depth = 0;
  if (parentId) {
    const parent = await env.DB.prepare('SELECT id, root_id, depth FROM posts WHERE id = ?')
      .bind(parentId)
      .first<{ id: string; root_id: string | null; depth: number | null }>();
    if (parent) {
      rootId = parent.root_id ?? parent.id;
      depth = (parent.depth ?? 0) + 1;
    }
  }

  const hashtags: string[] = [];
  const mentionedUsernames: string[] = [];
  const tags = Array.isArray(object.tag) ? (object.tag as NoteTag[]) : [];
  for (const tag of tags) {
    if (tag.type === 'Hashtag' && typeof tag.name === 'string') {
      const name = tag.name.replace(/^#/, '').trim();
      if (name && !hashtags.includes(name)) hashtags.push(name);
    } else if (tag.type === 'Mention' && typeof tag.href === 'string') {
      const mention = localProfileUsername(tag.href, env.BASE_URL);
      if (mention && !mentionedUsernames.includes(mention)) {
        mentionedUsernames.push(mention);
      }
    }
  }
  if (hashtags.length === 0) {
    for (const hashtag of text.matchAll(/#([\p{L}\p{N}_]{1,50})/gu)) {
      if (hashtag[1] && !hashtags.includes(hashtag[1])) hashtags.push(hashtag[1]);
    }
  }

  const postId = randomPostId();
  const objectId = typeof object.id === 'string' ? object.id : null;

  await env.DB.prepare(`
    INSERT INTO posts (id, user_id, username, text, hashtags, status, parent_id, root_id, depth, actor_id, ap_object_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `)
    .bind(postId, userId, username, text, JSON.stringify(hashtags), parentId, rootId, depth, actorId, objectId)
    .run();

  await notifyMentions(env, mentionedUsernames, username, postId, actorId);

  console.log('Note received and stored:', postId);
}

async function notifyMentions(
  env: HandlerEnv,
  mentionedUsernames: string[],
  authorUsername: string,
  postId: string,
  actorId: string,
): Promise<void> {
  const targets = mentionedUsernames.filter((name) => name.toLowerCase() !== authorUsername.toLowerCase());
  if (targets.length === 0) return;
  try {
    const placeholders = targets.map(() => '?').join(',');
    const mentioned = await env.DB.prepare(
      `SELECT id, username FROM users WHERE username IN (${placeholders}) COLLATE NOCASE`,
    )
      .bind(...targets)
      .all<{ id: string; username: string }>();
    if (!mentioned.results || mentioned.results.length === 0) return;

    const actorData = JSON.stringify({ username: authorUsername, display_name: authorUsername });
    const statements = mentioned.results.map((user) =>
      env.DB.prepare(
        'INSERT INTO notifications (id, user_id, type, post_id, actor_id, actor_data) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(randomId(), user.id, 'mention', postId, actorId, actorData),
    );
    await env.DB.batch(statements);
  } catch (error) {
    console.error('Failed to create mention notifications for ActivityPub post:', error);
  }
}

async function handleFollow(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const followerUserId = await localUserId(env, username);
  if (!followerUserId) {
    console.error('User not found:', username);
    return;
  }

  const existing = await env.DB.prepare('SELECT id FROM ap_followers WHERE local_user_id = ? AND actor_url = ?')
    .bind(followerUserId, actorId)
    .first();
  if (existing) {
    console.log('Follower already exists:', actorId);
    return;
  }

  // The actor document carries the inbox the Accept has to be delivered to.
  const actor = await resolveRemoteActor(actorId, env);
  const inboxUrl = actor?.inbox ?? actorId;
  const sharedInboxUrl = actor?.sharedInbox ?? null;

  await env.DB.prepare(`
    INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, shared_inbox_url, username, domain, display_name, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `)
    .bind(
      randomId(),
      followerUserId,
      actorId,
      inboxUrl,
      sharedInboxUrl,
      actor?.preferredUsername ?? null,
      actor?.domain ?? null,
      actor?.displayName ?? null,
    )
    .run();

  if (actor) {
    await env.DB.prepare(`
      INSERT INTO ap_actors (actor_url, inbox_url, shared_inbox_url, public_key_pem, preferred_username, display_name, icon_url, domain, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(actor_url) DO UPDATE SET
        inbox_url = excluded.inbox_url,
        shared_inbox_url = excluded.shared_inbox_url,
        public_key_pem = excluded.public_key_pem,
        preferred_username = excluded.preferred_username,
        display_name = excluded.display_name,
        icon_url = excluded.icon_url,
        domain = excluded.domain,
        fetched_at = excluded.fetched_at
    `)
      .bind(
        actor.actorUrl,
        actor.inbox,
        actor.sharedInbox,
        actor.publicKeyPem,
        actor.preferredUsername,
        actor.displayName,
        actor.iconUrl,
        actor.domain,
      )
      .run();
  }

  await notifyRemoteFollow(
    env,
    followerUserId,
    actorId,
    actor?.displayName ?? null,
    actor?.preferredUsername ?? null,
    actor?.domain ?? null,
  );

  await sendAccept(env, username, activity, actorId, inboxUrl);
}

async function notifyRemoteFollow(
  env: HandlerEnv,
  localUserId: string,
  actorId: string,
  displayName: string | null,
  preferredUsername: string | null,
  domain: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, post_id, actor_id, actor_data)
      VALUES (?, ?, 'ap_follow', '', ?, ?)
    `)
      .bind(
        randomId(),
        localUserId,
        actorId,
        JSON.stringify({
          username: preferredUsername ?? 'unknown',
          display_name: displayName ?? preferredUsername ?? 'Unknown User',
          domain: domain ?? 'unknown',
          actor_url: actorId,
        }),
      )
      .run();
  } catch (error) {
    console.error('Failed to create follow notification:', error);
  }
}

/**
 * Send the Accept of a follow request.
 *
 * The activity is queued instead of being delivered inline: a queued
 * delivery is retried and ends up in the dead letter queue when the remote
 * instance stays unreachable.
 */
async function sendAccept(
  env: HandlerEnv,
  username: string,
  followActivity: Record<string, unknown>,
  actorId: string,
  inboxUrl: string,
): Promise<void> {
  if (!env.AP_DELIVERY_QUEUE) return;

  const key = await env.DB.prepare(`
    SELECT ak.private_key_pem FROM actor_keys ak JOIN users u ON u.id = ak.user_id WHERE u.username = ? COLLATE NOCASE
  `)
    .bind(username)
    .first<{ private_key_pem: string }>();
  if (!key?.private_key_pem) {
    console.error('No private key found for user:', username);
    return;
  }

  const accept = buildAcceptActivity(env.BASE_URL, username, followActivity, randomId());
  await env.AP_DELIVERY_QUEUE.send({
    type: 'delivery',
    inboxUrl,
    activity: accept,
    senderUsername: username,
  });
  console.log('Queued Accept for follower:', actorId);
}

async function handleAccept(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  if (!object || object.type !== 'Follow') {
    console.log('Ignoring Accept for non-Follow activity');
    return;
  }
  // The Accept refers to the Follow we sent: its object is the actor we
  // wanted to follow, not the actor that accepted the request.
  const followActor = typeof object.object === 'string' ? object.object : object.actor;
  if (typeof followActor !== 'string') {
    console.error('Accept activity missing object actor');
    return;
  }

  const userId = await localUserId(env, username);
  if (!userId) return;

  await env.DB.prepare(
    `UPDATE ap_following SET status = 'accepted' WHERE local_user_id = ? AND target_actor_url = ? AND status != 'rejected'`,
  )
    .bind(userId, followActor)
    .run();
  console.log('Follow accepted from:', followActor);
}

async function handleReject(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  if (!object || object.type !== 'Follow') {
    console.log('Ignoring Reject for non-Follow activity');
    return;
  }
  const followActor = typeof object.object === 'string' ? object.object : object.actor;
  if (typeof followActor !== 'string') return;

  const userId = await localUserId(env, username);
  if (!userId) return;

  await env.DB.prepare(`UPDATE ap_following SET status = 'rejected' WHERE local_user_id = ? AND target_actor_url = ?`)
    .bind(userId, followActor)
    .run();
  console.log('Follow rejected by:', followActor);
}

async function handleLike(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  const objectUrl = object?.id;
  if (typeof objectUrl !== 'string') {
    console.error('Like activity missing object');
    return;
  }

  const postId = await resolveLikeTarget(env, objectUrl);
  if (!postId) {
    console.log('Liked object is not a local post:', objectUrl);
    return;
  }

  const post = await env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ id: string; user_id: string }>();
  if (!post) {
    console.log('Liked post not found:', postId);
    return;
  }

  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO likes (id, post_id, user_id, actor_id, created_at)
    VALUES (?, ?, NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `)
    .bind(randomId(), postId, actorId)
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    console.log('Like already exists:', postId, actorId);
    return;
  }

  if (post.user_id) {
    try {
      await env.DB.prepare('INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)')
        .bind(randomId(), post.user_id, 'ap_like', postId, actorId)
        .run();
    } catch (error) {
      console.error('Failed to create Like notification:', error);
    }
  }
  console.log('Like recorded:', postId, actorId);
}

/**
 * Find the local post an activity refers to.
 *
 * Both the URL of a local note and the ActivityPub object id of a post that
 * was received from another instance are accepted.
 */
async function resolveLikeTarget(env: HandlerEnv, objectUrl: string): Promise<string | null> {
  const local = localPostIdFromNoteUrl(objectUrl, env.BASE_URL);
  if (local) return local;
  const remote = await env.DB.prepare('SELECT id FROM posts WHERE ap_object_id = ?')
    .bind(objectUrl)
    .first<{ id: string }>();
  return remote?.id ?? null;
}

async function handleAnnounce(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  const objectUrl = object?.id;
  if (typeof objectUrl !== 'string') {
    console.error('Announce activity missing object');
    return;
  }

  const postId = await resolveLikeTarget(env, objectUrl);
  if (!postId) {
    console.log('Announced object is not a local post:', objectUrl);
    return;
  }

  const post = await env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ id: string; user_id: string }>();
  if (!post) {
    console.log('Announced post not found:', postId);
    return;
  }

  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO shares (id, post_id, user_id, actor_id, created_at)
    VALUES (?, ?, NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `)
    .bind(randomId(), postId, actorId)
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    console.log('Share already exists:', postId, actorId);
    return;
  }

  await env.DB.prepare(
    'UPDATE posts SET reload_count = reload_count + 1, engagement_hotness = engagement_hotness + 3.0 WHERE id = ?',
  )
    .bind(postId)
    .run();

  if (post.user_id) {
    try {
      await env.DB.prepare('INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)')
        .bind(randomId(), post.user_id, 'ap_announce', postId, actorId)
        .run();
    } catch (error) {
      console.error('Failed to create Announce notification:', error);
    }
  }
  console.log('Share recorded:', postId, actorId);
}

async function handleUndo(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  if (!object) {
    console.error('Undo activity missing object');
    return;
  }

  // The verified outer actor must own the activity being undone.
  if (activity.actor !== actorId || (object.actor !== undefined && object.actor !== actorId)) {
    console.warn('Ignoring Undo referring to a different actor');
    return;
  }

  switch (object.type) {
    case 'Like': {
      const objectUrl = typeof object.object === 'string' ? object.object : '';
      const postId = await resolveLikeTarget(env, objectUrl);
      if (postId) {
        await env.DB.prepare('DELETE FROM likes WHERE post_id = ? AND actor_id = ?').bind(postId, actorId).run();
        console.log('Like removed:', postId, actorId);
      }
      break;
    }
    case 'Announce': {
      const objectUrl = typeof object.object === 'string' ? object.object : '';
      const postId = await resolveLikeTarget(env, objectUrl);
      if (postId) {
        const removed = await env.DB.prepare('DELETE FROM shares WHERE post_id = ? AND actor_id = ?')
          .bind(postId, actorId)
          .run();
        if ((removed.meta?.changes ?? 0) > 0) {
          await env.DB.prepare(
            'UPDATE posts SET reload_count = MAX(0, reload_count - 1), engagement_hotness = MAX(0.0, engagement_hotness - 3.0) WHERE id = ?',
          )
            .bind(postId)
            .run();
          await env.DB.prepare("DELETE FROM notifications WHERE post_id = ? AND actor_id = ? AND type = 'ap_announce'")
            .bind(postId, actorId)
            .run();
        }
        console.log('Share removed:', postId, actorId);
      }
      break;
    }
    case 'Follow': {
      const userId = await localUserId(env, username);
      if (!userId) break;
      await env.DB.prepare('DELETE FROM ap_followers WHERE local_user_id = ? AND actor_url = ?')
        .bind(userId, actorId)
        .run();
      console.log('Follow removed:', actorId);
      break;
    }
    case 'Block': {
      const userId = await localUserId(env, username);
      if (!userId) break;
      await env.DB.prepare('DELETE FROM ap_blocks WHERE local_user_id = ? AND actor_url = ?')
        .bind(userId, actorId)
        .run();
      console.log('Block removed:', actorId);
      break;
    }
    default:
      console.log('Unknown undo object type:', object.type);
  }
}

async function handleDelete(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  const objectUrl = object?.id;
  if (typeof objectUrl !== 'string') {
    console.error('Delete activity missing object');
    return;
  }

  // A deleted actor loses its follower relation and its posts.
  if (object?.type === 'Person' || object?.type === 'Tombstone') {
    const isActor = objectUrl === actorId;
    if (isActor) {
      const userId = await localUserId(env, username);
      if (userId) {
        await env.DB.prepare('DELETE FROM ap_followers WHERE local_user_id = ? AND actor_url = ?')
          .bind(userId, actorId)
          .run();
      }
      await env.DB.prepare('UPDATE posts SET status = ?, hidden = 1 WHERE actor_id = ?').bind('deleted', actorId).run();
      console.log('Remote actor deleted:', actorId);
      return;
    }
  }

  const postId = await resolveLikeTarget(env, objectUrl);
  if (!postId) {
    console.log('Deleted object is not a local post:', objectUrl);
    return;
  }
  const post = await env.DB.prepare('SELECT actor_id FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ actor_id: string | null }>();
  if (!post) return;
  if (post.actor_id !== actorId) {
    console.warn('Ignoring Delete of a post owned by another actor');
    return;
  }
  await env.DB.prepare('UPDATE posts SET status = ?, hidden = 1 WHERE id = ?').bind('deleted', postId).run();
  console.log('Post deleted by its author:', postId);
}

async function handleUpdate(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  if (!object) {
    console.error('Update activity missing object');
    return;
  }
  if (activity.actor !== actorId || (object.attributedTo && object.attributedTo !== actorId)) {
    console.warn('Ignoring Update from a mismatched actor');
    return;
  }
  if (object.type !== 'Person' && object.type !== 'Service' && object.type !== 'Application') {
    console.log('Ignoring unsupported ActivityPub Update:', object.type);
    return;
  }

  const displayName = typeof object.name === 'string' ? object.name : null;
  const preferredUsername = typeof object.preferredUsername === 'string' ? object.preferredUsername : null;
  await env.DB.prepare(`
    UPDATE ap_actors SET display_name = ?, preferred_username = ?, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE actor_url = ?
  `)
    .bind(displayName, preferredUsername, actorId)
    .run();
  await env.DB.prepare('UPDATE ap_followers SET display_name = ?, username = ? WHERE actor_url = ?')
    .bind(displayName, preferredUsername, actorId)
    .run();
  console.log('Remote actor profile updated:', actorId);
}

async function handleBlock(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  const target =
    typeof object?.id === 'string' ? object.id : typeof activity.object === 'string' ? activity.object : null;
  if (!target) return;
  const userId = await localUserId(env, username);
  if (!userId) return;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO ap_blocks (id, local_user_id, actor_url, created_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `)
    .bind(randomId(), userId, target)
    .run();
  console.log('Block recorded:', target);
}

async function handleMove(
  env: HandlerEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  const movedTo = typeof object?.movedTo === 'string' ? object.movedTo : null;
  if (!movedTo) return;
  await env.DB.prepare(
    `UPDATE ap_actors SET moved_to = ?, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE actor_url = ?`,
  )
    .bind(movedTo, actorId)
    .run();
  console.log('Remote actor moved:', actorId, '->', movedTo);
}

/** URLs of the local actor, exported for the delivery side. */
export function localActorUrl(baseUrl: string, username: string): string {
  return actorUrl(baseUrl, username);
}

/** URL of a local post, exported for the delivery side. */
export function localNoteUrl(baseUrl: string, postId: string): string {
  return noteUrl(baseUrl, postId);
}
