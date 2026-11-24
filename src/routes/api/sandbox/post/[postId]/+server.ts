import { onRequest } from '../../../../../../functions/api/sandbox/post/[postId].ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/api/sandbox/post/[postId].ts
// into the SvelteKit Worker: Cloudflare Pages ignores functions/ once the
// generated _worker.js exists. The handler only returns the 410 retirement response.
type LegacyContext = Parameters<typeof onRequest>[0];

const handle: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
