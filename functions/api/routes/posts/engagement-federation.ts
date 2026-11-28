import { type Context } from 'hono';
import { nanoid } from 'nanoid';
import { buildLikeActivity, buildUndoActivity } from '../../../lib/activitypub/activities';
import { deliverToActorInbox, deliverToFollowers } from '../../../lib/activitypub/delivery';
import { waitUntil } from '../../../lib/notify';
import type { Bindings, Variables } from '../../types';

export type PostsContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/** Post columns needed to address a Like to the right object and inbox. */
export type FederatedPost = {
  id: string;
  actor_id: string | null;
  ap_object_id: string | null;
  visibility?: string | null;
};

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
 * Queue a Like (or its Undo) for the author of a remote post.
 *
 * Only mirrored remote posts carry an `actor_id`, i.e. an inbox that can
 * receive the Like; a purely local post has no remote author to notify. Callers
 * pass at most one entry per post, so a batch produces exactly one activity per
 * post. Delivery is always scheduled with `waitUntil` and never awaited on the
 * request's critical path. Restricted posts are never liked publicly, even by
 * a viewer who is allowed to read them.
 */
export function deliverFreshLike(
  c: PostsContext,
  post: FederatedPost,
  username: string,
  action: 'add' | 'remove',
): void {
  if (!isPublicVisibility(post.visibility)) return;
  const actorUrl = post.actor_id;
  if (!actorUrl) return;
  const like = buildLikeActivity(c.env.BASE_URL, username, engagementObjectUrl(c.env.BASE_URL, post), nanoid());
  const activity = action === 'add' ? like : buildUndoActivity(c.env.BASE_URL, username, like, nanoid());
  waitUntil(
    c,
    () => deliverToActorInbox(c.env, { actorUrl, username, activity }),
    `Failed to deliver ${activity.type} to remote actor`,
  );
}

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
