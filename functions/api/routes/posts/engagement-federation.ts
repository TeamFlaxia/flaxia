import { type Context } from 'hono';
import { nanoid } from 'nanoid';
import { buildLikeActivity, buildUndoActivity } from '../../../lib/activitypub/activities';
import {
  type DeliveryEnv,
  deliverToActorInbox,
  deliverToFollowers,
  deliverToInbox,
} from '../../../lib/activitypub/delivery';
import { audienceFor, type Visibility } from '../../../lib/activitypub/note';
import { waitUntil } from '../../../lib/notify';
import type { Bindings, Variables } from '../../types';

export type PostsContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/** Post columns needed to address a Like to the right object and inbox. */
export type FederatedPost = {
  id: string;
  user_id?: string | null;
  username?: string | null;
  actor_id: string | null;
  ap_object_id: string | null;
  visibility?: string | null;
};

interface FollowerInboxRow {
  actor_url: string;
  inbox_url: string;
  shared_inbox_url: string | null;
  blocked: number;
}

/**
 * Remote inboxes of a local post author, excluding actors the author blocked.
 *
 * A blocked follower must not receive the Like even when it shares an instance
 * inbox with an unblocked follower: in that case the unblocked followers are
 * reached through their personal inboxes, never through the shared one.
 */
async function collectUnblockedFollowerInboxes(env: DeliveryEnv, authorUserId: string): Promise<string[]> {
  const followers = await env.DB.prepare(
    `SELECT f.actor_url, f.inbox_url, f.shared_inbox_url,
            CASE WHEN b.actor_url IS NULL THEN 0 ELSE 1 END AS blocked
     FROM ap_followers f
     LEFT JOIN ap_blocks b ON b.local_user_id = f.local_user_id AND b.actor_url = f.actor_url
     WHERE f.local_user_id = ?`,
  )
    .bind(authorUserId)
    .all<FollowerInboxRow>();

  const rows = followers.results ?? [];
  const sharedWithBlocked = new Set(
    rows.filter((row) => row.blocked && row.shared_inbox_url).map((row) => row.shared_inbox_url as string),
  );
  const inboxes = new Set<string>();
  for (const row of rows) {
    if (row.blocked) continue;
    const inbox =
      row.shared_inbox_url && !sharedWithBlocked.has(row.shared_inbox_url) ? row.shared_inbox_url : row.inbox_url;
    if (inbox) inboxes.add(inbox);
  }
  return [...inboxes];
}

/**
 * Only public/unlisted posts may leave the instance as an AP activity or in a
 * notification body. A legacy NULL visibility predates the column and means
 * public, matching `visibilityFilter`.
 */
export function isPublicVisibility(visibility: string | null | undefined): boolean {
  const value = visibility ?? 'public';
  return value === 'public' || value === 'unlisted';
}

/**
 * ActivityPub object id of a post. Mirrored remote posts keep the id they were
 * published with; local posts are addressed by their canonical note URL.
 */
function engagementObjectUrl(baseUrl: string, post: FederatedPost): string {
  return post.ap_object_id ?? `${baseUrl}/api/notes/${post.id}`;
}

/**
 * Queue a Like (or its Undo) for a post the viewer Freshed.
 *
 * A mirrored remote post is liked at its original author's inbox. A local post
 * is liked to the remote followers of its author — the audience its Note was
 * federated to — using the liker's signed identity. A post with no author or
 * no remote inboxes was never federated and produces no delivery. Callers only
 * invoke this when a `freshs` row is inserted or deleted, so a repeat or an
 * unrelated read cannot re-deliver the activity. Restricted posts are never
 * liked publicly, even by a viewer who is allowed to read them.
 */
export function deliverFreshLike(
  c: PostsContext,
  post: FederatedPost,
  username: string,
  action: 'add' | 'remove',
): void {
  if (!isPublicVisibility(post.visibility)) return;
  const objectUrl = engagementObjectUrl(c.env.BASE_URL, post);

  if (post.actor_id) {
    const actorUrl = post.actor_id;
    const like = buildLikeActivity(c.env.BASE_URL, username, objectUrl, nanoid());
    const activity = action === 'add' ? like : buildUndoActivity(c.env.BASE_URL, username, like, nanoid());
    waitUntil(
      c,
      () => deliverToActorInbox(c.env, { actorUrl, username, activity }),
      `Failed to deliver ${activity.type} to remote actor`,
    );
    return;
  }

  // A local post without an author row cannot have been federated.
  if (!post.user_id || !post.username) return;
  const visibility: Visibility = post.visibility === 'unlisted' ? 'unlisted' : 'public';
  const followersUrl = `${c.env.BASE_URL}/api/actors/${encodeURIComponent(post.username)}/followers`;
  const audience = audienceFor(visibility, { followersUrl });
  const like = buildLikeActivity(c.env.BASE_URL, username, objectUrl, nanoid(), audience);
  const activity = action === 'add' ? like : buildUndoActivity(c.env.BASE_URL, username, like, nanoid(), audience);
  const authorUserId = post.user_id;
  waitUntil(
    c,
    async () => {
      const inboxes = await collectUnblockedFollowerInboxes(c.env, authorUserId);
      await Promise.allSettled(inboxes.map((inboxUrl) => deliverToInbox(c.env, { inboxUrl, username, activity })));
    },
    `Failed to deliver ${activity.type} to the followers of a local post`,
  );
}

/**
 * Reload is Flaxia's boost: ActivityPub already has an equivalent, `Announce`,
 * so the outbound path reuses that activity (with Undo on withdrawal) instead
 * of inventing a new one. The generic emoji reaction picker has no ActivityPub
 * equivalent: only the Fresh action is translated into Like/Undo.
 */

/**
 * Delivers a reload Announce/Undo to the reloading user's federated followers
 * and, for remote posts, to the original author's inbox.
 */
export function deliverReloadActivity(
  c: PostsContext,
  post: { actor_id: string | null; visibility?: string | null },
  currentUser: { id: string; username: string },
  activity: Record<string, unknown>,
): void {
  if (!isPublicVisibility(post.visibility)) return;
  const actorUrl = post.actor_id;
  waitUntil(
    c,
    async () => {
      try {
        await deliverToFollowers(c.env, {
          userId: currentUser.id,
          username: currentUser.username,
          activity,
        });
      } catch (e) {
        console.error('Failed to deliver reload activity to followers:', e);
      }

      if (actorUrl) {
        try {
          await deliverToActorInbox(c.env, { actorUrl, username: currentUser.username, activity });
        } catch (e) {
          console.error('Failed to deliver reload activity to remote actor:', e);
        }
      }
    },
    'Failed to deliver reload activity',
  );
}
