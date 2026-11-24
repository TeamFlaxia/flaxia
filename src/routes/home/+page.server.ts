import { loadFeed } from '../../lib/server/ssr-data.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ request, platform, setHeaders }) => {
  // Personalized (following) feeds share this route, so never let an edge cache
  // replay one user's timeline to another.
  setHeaders({ 'Cache-Control': 'private, no-store' });
  const env = platform?.env;
  if (!env?.DB) return { posts: [] };
  const feed = await loadFeed(request, env as never, 20);
  return { posts: feed.posts };
};
