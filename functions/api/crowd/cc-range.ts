// Signed Common Crawl byte-range proxy for `cc-extract` nodes. Kept separate
// from the node bundle proxy so the Crowd protocol boundary stays explicit.
import { handleCcRangeRequest } from '../../lib/cc-range';
import type { Bindings } from '../types';

export async function onRequest(context: { request: Request; env: Bindings }) {
  return handleCcRangeRequest(context.request, context.env);
}
