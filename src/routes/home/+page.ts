import { loadFeed } from '../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

// SSR renders the feed through the in-process Hono app. SvelteKit re-runs
// universal loads on hydration and replaces the serialized server data with
// the client result, so on the web this load must return the real data again
// (its SSR fetch response is serialized and replayed by SvelteKit). Only the
// native static build has no SSR handover: there the interactive Timeline
// owns fetching, so it gets an empty payload.
export const load: PageLoad = async ({ fetch, setHeaders }) => {
  if (import.meta.env.BUILD_TARGET === 'native') return { posts: [], nextCursor: undefined };
  setHeaders({ 'Cache-Control': 'private, no-store' });
  return await loadFeed(fetch, 20);
};
