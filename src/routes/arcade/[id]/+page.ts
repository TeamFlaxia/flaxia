import { error } from '@sveltejs/kit';
import { browser } from '$app/env';
import { loadGames, loadThread } from '../../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, setHeaders }) => {
  if (browser) return { game: null, post: null, replies: [] };
  setHeaders({ 'Cache-Control': 'private, max-age=0, s-maxage=60' });
  if (!params.id) throw error(404, 'Game not found');
  const [games, thread] = await Promise.all([loadGames(fetch, 50), loadThread(fetch, params.id)]);
  if (!thread.root) throw error(404, 'Game not found');
  return {
    game: games.find((game) => game.postId === params.id) ?? null,
    post: thread.root,
    replies: thread.replies,
  };
};
