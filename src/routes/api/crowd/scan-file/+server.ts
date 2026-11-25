import { onRequest } from '../../../../../functions/api/crowd/scan-file.ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/api/crowd/scan-file.ts into the
// SvelteKit Worker: Cloudflare Pages ignores functions/ once the generated
// _worker.js exists, so the Crowd scan upload endpoint is registered here.
type LegacyContext = Parameters<typeof onRequest>[0];

const handle: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);

// The legacy handler serves the signed ticket download with GET and answers
// CORS preflight with OPTIONS; every other method returns 404 from the handler.
export const GET = handle;
export const OPTIONS = handle;
