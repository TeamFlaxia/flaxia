import { onRequest } from '../../../../../functions/api/market/checkout.ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/api/market/checkout.ts into the
// SvelteKit Worker: Cloudflare Pages ignores functions/ once the generated
// _worker.js exists, so the market checkout endpoint is registered here.
type LegacyContext = Parameters<typeof onRequest>[0];

export const POST: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    waitUntil: (p: Promise<unknown>) => platform?.context?.waitUntil(p),
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);

export const OPTIONS: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    waitUntil: (p: Promise<unknown>) => platform?.context?.waitUntil(p),
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);
