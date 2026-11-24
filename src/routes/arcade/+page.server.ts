import { loadGames } from '../../lib/server/ssr-data.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ request, platform, setHeaders }) => {
  const env = platform?.env;
  if (!env?.DB) return { games: [] };
  setHeaders({ 'Cache-Control': 'private, max-age=0, s-maxage=60' });
  return { games: await loadGames(request, env as never, 30) };
};
