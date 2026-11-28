import { handlePersonalInbox, type InboxEnv } from '../../../../../functions/lib/activitypub/inbox.ts';
import type { RequestHandler } from './$types';

/**
 * Legacy personal inbox under `/users/:username`.
 *
 * Like `/actors/:username/inbox`, this must be handled in place rather than
 * redirected: a 308 would make peers recompute `(request-target)` and break
 * the HTTP Signature. Both legacy spellings share the canonical verification
 * pipeline.
 */
const post: RequestHandler = ({ request, params, platform }) => {
  const env = platform?.env as unknown as InboxEnv | undefined;
  if (!env) return new Response('Server bindings unavailable', { status: 500 });
  return handlePersonalInbox(env, request, params.username);
};

export const POST = post;
