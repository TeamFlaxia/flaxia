import { error } from '@sveltejs/kit';
import { loadProfile, loadUserFeed } from '../../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, setHeaders }) => {
  if (import.meta.env.BUILD_TARGET === 'native') return { user: null, posts: [] };
  setHeaders({ 'Cache-Control': 'private, no-store' });
  if (!params.username) throw error(404, 'User not found');
  const [profile, feed] = await Promise.all([
    loadProfile(fetch, params.username),
    loadUserFeed(fetch, params.username, 20),
  ]);
  if (!profile.user) throw error(404, 'User not found');
  return { user: profile.user, posts: feed.posts };
};
