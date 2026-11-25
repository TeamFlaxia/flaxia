import { loadGames } from '../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, setHeaders }) => {
  if (import.meta.env.BUILD_TARGET === 'native') return { games: [] };
  setHeaders({ 'Cache-Control': 'private, no-store' });
  return { games: await loadGames(fetch, 30) };
};
