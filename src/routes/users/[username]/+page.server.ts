import { error } from '@sveltejs/kit';
import { loadProfile, loadUserFeed } from '../../../lib/server/ssr-data.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, platform, setHeaders }) => {
  const env = platform?.env;
  if (!env?.DB) throw error(500, 'Database not available');
  if (!params.username) throw error(404, 'User not found');
  setHeaders({ 'Cache-Control': 'private, no-store' });
  const [profile, feed] = await Promise.all([
    loadProfile(request, env as never, params.username),
    loadUserFeed(request, env as never, params.username, 20),
  ]);
  if (!profile.user) throw error(404, 'User not found');
  return { user: profile.user, posts: feed.posts };
};
