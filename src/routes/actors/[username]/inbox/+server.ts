import { handlePersonalInbox, type InboxEnv } from '../../../../../functions/lib/activitypub/inbox.ts';
import type { RequestHandler } from './$types';

/**
 * Legacy personal inbox of an actor.
 *
 * This route must not redirect to `/api/actors/:username/inbox`: a peer signs
 * `(request-target)` with the URL it was given, so a 308 would make the
 * signature invalid at the destination. Handling the POST on the original path
 * keeps the signed target intact while reusing the same verification pipeline
 * as the canonical inbox.
 */
const post: RequestHandler = ({ request, params, platform }) => {
  const env = platform?.env as unknown as InboxEnv | undefined;
  if (!env) return new Response('Server bindings unavailable', { status: 500 });
  return handlePersonalInbox(env, request, params.username);
};

export const POST = post;
