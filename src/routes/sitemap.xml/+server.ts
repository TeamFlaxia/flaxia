import { onRequest } from '../../../functions/sitemap.xml.ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/sitemap.xml.ts into the
// SvelteKit Worker: Cloudflare Pages ignores functions/ once the generated
// _worker.js exists, so the Hono-backed sitemap is registered here.
type LegacyContext = Parameters<typeof onRequest>[0];

export const GET: RequestHandler = ({ request, platform, params }) =>
  onRequest({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    waitUntil: (p: Promise<unknown>) => platform?.context?.waitUntil(p),
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);
