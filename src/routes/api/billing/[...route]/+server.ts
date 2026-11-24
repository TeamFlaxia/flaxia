import { onRequest } from '../../../../../functions/api/billing/[[route]].ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/api/billing/[[route]].ts into
// the SvelteKit Worker: Cloudflare Pages ignores functions/ once the generated
// _worker.js exists, so the billing routes have to be registered here. The
// legacy handler still owns routing on the trailing path segments.
type LegacyContext = Parameters<typeof onRequest>[0];

const handle: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    waitUntil: (p: Promise<unknown>) => platform?.context?.waitUntil(p),
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
