import { onRequest } from '../../../../../functions/api/ogp-player/[id].ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/api/ogp-player/[id].ts into the
// SvelteKit Worker: Cloudflare Pages ignores functions/ once the generated
// _worker.js exists, so the OGP player page is registered here.
type LegacyContext = Parameters<typeof onRequest>[0];

export const GET: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params: { id: params.id },
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);
