import { onRequest } from '../../../../../functions/api/crowd/scan-file.ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/api/crowd/scan-file.ts into the
// SvelteKit Worker: Cloudflare Pages ignores functions/ once the generated
// _worker.js exists, so the Crowd scan upload endpoint is registered here.
type LegacyContext = Parameters<typeof onRequest>[0];

export const POST: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);
