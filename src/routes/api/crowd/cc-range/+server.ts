import { onRequest } from '../../../../../functions/api/crowd/cc-range.ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/api/crowd/cc-range.ts into the
// SvelteKit Worker: Cloudflare Pages ignores functions/ once the generated
// _worker.js exists, so the signed Common Crawl range proxy is registered here.
type LegacyContext = Parameters<typeof onRequest>[0];

const handle: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);

export const GET = handle;
export const POST = handle;
// Cross-origin Crowd nodes send a custom `Range` header, so preflight must be
// answered by the legacy handler's 204 CORS branch.
export const OPTIONS = handle;
