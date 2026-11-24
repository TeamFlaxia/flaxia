import { onRequestGet } from '../../../functions/host-meta.ts';
import type { RequestHandler } from './$types';

// Bridges the legacy Pages Function in functions/host-meta.ts into the
// SvelteKit Worker: Cloudflare Pages ignores functions/ once the generated
// _worker.js exists, so the WebFinger host-meta document is registered here.
type LegacyContext = Parameters<typeof onRequestGet>[0];

export const GET: RequestHandler = ({ request, platform, params }) =>
  onRequestGet({
    request,
    env: platform?.env as unknown as LegacyContext['env'],
    params,
    next: () => new Response(null, { status: 404 }),
  } as unknown as LegacyContext);
