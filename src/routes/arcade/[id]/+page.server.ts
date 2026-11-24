import { error } from '@sveltejs/kit';
import { loadGames, loadThread } from '../../../lib/server/ssr-data.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, platform, setHeaders }) => {
  const env = platform?.env;
  if (!env?.DB) throw error(500, 'Database not available');
  if (!params.id) throw error(404, 'Game not found');
  setHeaders({ 'Cache-Control': 'private, max-age=0, s-maxage=60' });
  const [games, thread] = await Promise.all([
    loadGames(request, env as never, 50),
    loadThread(request, env as never, params.id),
  ]);
  if (!thread.root) throw error(404, 'Game not found');
  return {
    game: games.find((game) => game.postId === params.id) ?? null,
    post: thread.root,
    replies: thread.replies,
  };
};
