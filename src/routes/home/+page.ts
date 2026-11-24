import { browser } from '$app/env';
import { loadFeed } from '../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

// SSR calls the Hono app in-process. On the client the interactive Timeline
// already owns fetching (and the native shell patches window.fetch), so the
// load only supplies data for the server-rendered first paint.
export const load: PageLoad = async ({ fetch, setHeaders }) => {
  if (browser) return { posts: [], nextCursor: undefined };
  setHeaders({ 'Cache-Control': 'private, no-store' });
  return await loadFeed(fetch, 20);
};
