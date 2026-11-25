import { type Bindings, handleApi } from '../../../../functions/api/[[route]].ts';
import type { RequestHandler } from './$types';

// The legacy Hono app owns /api/*. Keeping the catch-all here means the
// adapter-cloudflare Worker can serve it from the same deploy as SSR HTML.
const handle: RequestHandler = ({ request, platform }) =>
  handleApi(request, platform?.env as unknown as Bindings, platform?.context as unknown as ExecutionContext);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
